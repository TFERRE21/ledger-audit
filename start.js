import fs from "fs";
import path from "path";

const ethersPath = "/app/node_modules/ethers";
const pgPath = "/app/node_modules/pg";

console.log("[CHECK] Node:", process.version);
console.log("[CHECK] /app existe:", fs.existsSync("/app"));
console.log("[CHECK] package.json:", fs.existsSync("/app/package.json"));
console.log("[CHECK] node_modules:", fs.existsSync("/app/node_modules"));
console.log("[CHECK] ethers:", fs.existsSync(ethersPath));
console.log("[CHECK] pg:", fs.existsSync(pgPath));

if (fs.existsSync("/app/node_modules")) {
  console.log(
    "[CHECK] node_modules:",
    fs.readdirSync("/app/node_modules").slice(0, 50)
  );
}

const { default: start } = await import("./api/server.js");

if (typeof start === "function") {
  await start();
}
