import { createServer } from "node:http";

const port = Number(process.env.PORT || 3000);

createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, service: "ledger-audit" }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(port, () => {
  console.log(`ledger-audit listening on ${port}`);
});
