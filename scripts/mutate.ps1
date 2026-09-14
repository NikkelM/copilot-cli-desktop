param(
  [Parameter(Mandatory)][string]$Source,
  [Parameter(Mandatory)][string]$Tests,
  [Parameter(Mandatory)][string]$Mutations
)

# Asks whether the tests would notice if the code were wrong.
#
# Swaps one snippet at a time into $Source, reruns $Tests, and reports whether the suite
# failed. A surviving mutation means that line is asserted by nothing: the tests execute it
# but no expectation depends on it being right.
#
# $Mutations is a JSON array of { name, from, to }. `from` must appear verbatim in $Source.
# The file is restored even if a run is interrupted.
#
#   .\scripts\mutate.ps1 -Source src\lib\timeline.ts `
#                        -Tests src/lib/timeline.test.ts `
#                        -Mutations scripts\mutations.example.json

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# Accept both a path relative to the repository and an absolute one, so a mutation list can
# live outside the tree without being silently glued onto the repository root.
function Resolve-Input([string]$path) {
  if ([System.IO.Path]::IsPathRooted($path)) { return $path }
  return Join-Path $root $path
}

$sourcePath = Resolve-Input $Source
$original = Get-Content $sourcePath -Raw
$plan = Get-Content (Resolve-Input $Mutations) -Raw | ConvertFrom-Json

$caught = 0
$skipped = 0
try {
  foreach ($mutation in $plan) {
    if (-not $original.Contains($mutation.from)) {
      Write-Host "SKIP   $($mutation.name) - snippet not found in $Source" -ForegroundColor Yellow
      $skipped++
      continue
    }
    Set-Content $sourcePath ($original.Replace($mutation.from, $mutation.to)) -NoNewline
    & npx vitest run $Tests --silent 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "ALIVE  $($mutation.name)" -ForegroundColor Red
    } else {
      Write-Host "caught $($mutation.name)" -ForegroundColor Green
      $caught++
    }
  }
} finally {
  Set-Content $sourcePath $original -NoNewline
}

$attempted = $plan.Count - $skipped
Write-Host "`n$caught/$attempted caught"
# Explicit, both ways: without it the exit code is whichever one the last vitest run left
# behind, which is 1 exactly when the final mutation was caught.
if ($caught -lt $attempted) { exit 1 }
exit 0
