import fs from "fs";

const ethersPath = "/app/node_modules/ethers";
const pgPath = "/app/node_modules/pg";

console.log("========================================");
console.log("[START] Diagnóstico do ambiente");
console.log("========================================");

console.log("[CHECK] Node:", process.version);
console.log("[CHECK] Diretório atual:", process.cwd());

console.log("[CHECK] /app existe:", fs.existsSync("/app"));
console.log(
  "[CHECK] package.json:",
  fs.existsSync("/app/package.json")
);
console.log(
  "[CHECK] node_modules:",
  fs.existsSync("/app/node_modules")
);

console.log(
  "[CHECK] ethers:",
  fs.existsSync(ethersPath)
);

console.log(
  "[CHECK] pg:",
  fs.existsSync(pgPath)
);

if (fs.existsSync("/app/node_modules")) {
  try {
    const modules = fs
      .readdirSync("/app/node_modules")
      .filter((name) => !name.startsWith("."))
      .sort();

    console.log(
      "[CHECK] Quantidade de módulos:",
      modules.length
    );

    console.log(
      "[CHECK] Primeiros módulos:",
      modules.slice(0, 50)
    );

    console.log(
      "[CHECK] ethers instalado:",
      modules.includes("ethers")
    );

    console.log(
      "[CHECK] pg instalado:",
      modules.includes("pg")
    );
  } catch (error) {
    console.error(
      "[CHECK] Erro ao ler node_modules:",
      error.message
    );
  }
}

console.log("========================================");
console.log("[START] Iniciando API");
console.log("========================================");

try {
  const { default: start } = await import("./api/server.js");

  if (typeof start === "function") {
    await start();
  } else {
    console.log(
      "[START] api/server.js não exporta uma função default."
    );
  }
} catch (error) {
  console.error("========================================");
  console.error("[START] ERRO AO INICIAR API");
  console.error("========================================");

  console.error("[START] Nome:", error?.name);
  console.error("[START] Código:", error?.code);
  console.error("[START] Mensagem:", error?.message);
  console.error("[START] Stack:");
  console.error(error?.stack);

  process.exitCode = 1;
}
