import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execFile } from "node:child_process";

import {
  SIDECAR_BEHIND_EVENT,
  SIDECAR_REBUILD_EVENT,
  SIDECAR_REBUILT_EVENT,
  affectsRunningSidecar,
} from "./src/lib/sidecarFreshness.ts";

const host = process.env.TAURI_DEV_HOST;

/** Run one npm script to completion, resolving with whatever went wrong. */
function npmRun(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    // Through a shell on Windows, where npm is a `.cmd` that Node will not spawn directly.
    execFile(
      "npm",
      ["run", script],
      { shell: process.platform === "win32" },
      (error: Error | null, _stdout: string, stderr: string) => {
        if (!error) resolve(null);
        else resolve(stderr?.trim() || error.message);
      },
    );
  });
}

/**
 * Tell the window when the sidecar it is talking to has been left behind, and rebuild it
 * when the window asks.
 *
 * The dev server is the only part of this that can see both halves: it watches the source
 * tree, and it has a channel to the running window. The sidecar has neither - it was
 * started once from a copy of its compiled output and cannot tell that the files it came
 * from have moved on (#169).
 *
 * A change while the server is up is sufficient on its own. The sidecar is built by
 * `beforeDevCommand` immediately before this server starts, so anything edited afterwards
 * is by definition not in the process that is running.
 */
function sidecarFreshness() {
  return {
    name: "sidecar-freshness",
    apply: "serve" as const,
    configureServer(server: {
      watcher: { on: (event: string, handler: (file: string) => void) => void };
      ws: {
        on: (event: string, handler: () => void) => void;
        send: (payload: unknown) => void;
      };
    }) {
      const changed = (file: string) => {
        if (!affectsRunningSidecar(file)) return;
        server.ws.send({ type: "custom", event: SIDECAR_BEHIND_EVENT, data: { file } });
      };

      // Added and removed as well as changed: a new handler file is exactly the kind of
      // edit that produces `Unknown method` against the process already running.
      server.watcher.on("change", changed);
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);

      // Only the compile. `bundle:sidecar` stages a copy for packaging, which is not what
      // a running app loads, and the restart below points the replacement straight at what
      // this produces.
      server.ws.on(SIDECAR_REBUILD_EVENT, async () => {
        const error = await npmRun("build:sidecar");
        server.ws.send({ type: "custom", event: SIDECAR_REBUILT_EVENT, data: { error } });
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), sidecarFreshness()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 explicitly. Left to its default, Vite binds only ::1 while the webview
    // may resolve localhost to 127.0.0.1, which is then refused and renders a blank window.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

