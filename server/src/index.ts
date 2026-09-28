import express from "express";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { recoverAfterRestart } from "./cell.js";
import { plan } from "./core.js";
import { migrate, query } from "./db.js";
import { errorHandler } from "./http.js";
import { panels } from "./routes/panels.js";
import { revisions } from "./routes/revisions.js";
import { runs } from "./routes/runs.js";
import { ensureSeeds } from "./seed.js";

process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// Keep-alive target: deliberately does not touch the database, so a hosted Postgres
// that suspends when idle is not woken every few minutes.
app.get("/api/ping", (_req, res) => {
  res.type("text").send("ok");
});

app.get("/api/health", async (_req, res) => {
  await query("select 1");
  res.json({ ok: true, core: plan({ name: "x", plate: { length_mm: 1, width_mm: 1, thickness_mm: 1 }, stiffeners: [] }).issues.length === 0 });
});

app.use("/api", panels, revisions, runs);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// In production the server also hosts the built frontend.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { maxAge: "1h", index: false }));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile("index.html", { root: webDist });
  });
}

app.use(errorHandler);

const port = Number(process.env.PORT ?? 3001);
await migrate();
await ensureSeeds();
await recoverAfterRestart();
app.listen(port, () => console.log(`seamline listening on :${port}`));
