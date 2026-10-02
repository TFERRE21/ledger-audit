import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["api/server.js"], { stdio: "inherit", env: process.env }),
  spawn(process.execPath, ["scanner/runScan.js"], { stdio: "inherit", env: process.env })
];

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`[START] child exited code=${code} signal=${signal || "none"}`);
    }
  });
  child.on("error", error => {
    console.error("[START] child error:", error.message);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
