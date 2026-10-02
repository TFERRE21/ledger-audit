import { spawn } from "node:child_process";

const api = spawn(process.execPath, ["api/server.js"], {
  stdio: "inherit",
  env: process.env
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!api.killed) api.kill(signal);
}

api.on("error", error => {
  console.error("[START] API error:", error.message);
});

api.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error("[START] API exited code=" + (code ?? "null") + " signal=" + (signal ?? "none"));
  process.exit(code || 1);
});

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
