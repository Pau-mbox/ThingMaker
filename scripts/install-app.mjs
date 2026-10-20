import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const script = fileURLToPath(new URL(windows ? "./install-app.ps1" : "./install-app.sh", import.meta.url));
const args = windows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...process.argv.slice(2)]
  : [script, ...process.argv.slice(2)];
const result = spawnSync(windows ? "powershell.exe" : "bash", args, { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
