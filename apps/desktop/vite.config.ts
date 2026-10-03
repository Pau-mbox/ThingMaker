import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const shim = (name: string) => fileURLToPath(new URL(`./src/remote/shims/${name}.ts`, import.meta.url));

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(({ mode }) => {
  // `--mode remote` builds the phone's screens: the same renderer, with
  // Tauri's APIs replaced by the bridge to the Mac, served by the Mac at /app/.
  const remote = mode === "remote";
  return {
    plugins: [react()],
    clearScreen: false,
    base: remote ? "/app/" : "/",
    resolve: remote
      ? {
          alias: {
            "@tauri-apps/api/core": shim("core"),
            "@tauri-apps/api/event": shim("event"),
            "@tauri-apps/api/webview": shim("webview"),
            "@tauri-apps/plugin-notification": shim("notification"),
          },
        }
      : {},
    server: {
      port: 1420,
      strictPort: true,
      host: host ?? false,
      ...(host ? { hmr: { protocol: "ws", host, port: 1421 } } : {}),
      watch: { ignored: ["**/src-tauri/**"] },
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: {
      outDir: remote ? "dist-remote" : "dist",
      target: remote ? "chrome100" : process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
      // Vite 8 minifies with Oxc by default; debug builds keep readable output.
      minify: !process.env.TAURI_ENV_DEBUG,
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
  };
});
