# Capture the Copilot CLI Desktop window to a PNG for visual inspection.
#
# Uses PrintWindow against the window's own buffer rather than copying pixels from the
# screen. That way the capture contains only this app, never whatever else happens to be
# on the desktop, and it works without stealing focus or requiring the window to be visible.
param(
  [string]$Out = "$env:TEMP\ccd-shot.png",
  [string]$ProcessName = "copilot-cli-desktop",
  [switch]$List
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<IntPtr> ForProcess(uint target) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString();
  }
}
"@

# Without this the host process sees virtualised coordinates on a scaled display, so the
# window measures smaller than it really is and the capture comes out cropped.
# -4 is DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
[void][WinCap]::SetProcessDpiAwarenessContext([IntPtr](-4))

$procs = Get-Process $ProcessName -ErrorAction SilentlyContinue
if (-not $procs) { Write-Error "Process '$ProcessName' is not running"; exit 1 }

$candidates = @()
foreach ($p in $procs) {
  foreach ($h in [WinCap]::ForProcess([uint32]$p.Id)) {
    $r = New-Object WinCap+RECT
    [void][WinCap]::GetWindowRect($h, [ref]$r)
    $candidates += [pscustomobject]@{
      Handle = $h; OwnerPid = $p.Id; Title = [WinCap]::Title($h)
      W = $r.Right - $r.Left; H = $r.Bottom - $r.Top
    }
  }
}

if ($List) { $candidates | Sort-Object { $_.W * $_.H } -Descending | Format-Table -AutoSize; exit 0 }

# Prefer a titled window; helper windows are untitled and only a few pixels across.
$win = $candidates | Where-Object { $_.Title } | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
if (-not $win) { Write-Error "No titled window found for '$ProcessName'"; exit 1 }

$r = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($win.Handle, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -lt 100 -or $h -lt 100) { Write-Error "Window is only ${w}x${h}; it may be minimised"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT, required for GPU composited surfaces such as WebView2.
$ok = [WinCap]::PrintWindow($win.Handle, $hdc, 2)
$g.ReleaseHdc($hdc)

if (-not $ok) { $g.Dispose(); $bmp.Dispose(); Write-Error "PrintWindow failed"; exit 1 }

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$dpi = [WinCap]::GetDpiForWindow($win.Handle)
Write-Output "saved $Out (${w} x ${h}) dpi=$dpi scale=$([math]::Round($dpi/96*100))% pid=$($win.OwnerPid) title='$($win.Title)'"
