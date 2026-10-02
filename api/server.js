import { createServer } from "node:http";

const port = Number(process.env.PORT || 3000);

createServer((req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");

  if (req.url === "/health") {
    res.end(JSON.stringify({
      ok: true,
      service: "ledger-audit",
      environment: process.env.NODE_ENV || "development"
    }));
    return;
  }

  if (req.url === "/") {
    res.end(JSON.stringify({
      service: "ledger-audit",
      status: "online",
      endpoints: ["/health"]
    }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(port, "0.0.0.0", () => {
  console.log(`ledger-audit listening on 0.0.0.0:${port}`);
});
