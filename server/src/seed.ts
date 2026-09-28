import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plan } from "./core.js";
import { query, tx } from "./db.js";

const samplesDir = fileURLToPath(new URL("../../samples", import.meta.url));
/** Panels created on first boot, released and locked so every visitor can run them. */
const SEEDS = ["mp-220-deck.json", "mp-104-grid.json", "mp-101-flat.json"];

export function sampleSpecs(): { key: string; spec: any }[] {
  return fs
    .readdirSync(samplesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ key: f.replace(/\.json$/, ""), spec: JSON.parse(fs.readFileSync(path.join(samplesDir, f), "utf8")) }));
}

/** Insert any missing seed panel. Never deletes: a restart must not wipe runs in progress. */
export async function ensureSeeds() {
  for (const file of [...SEEDS].reverse()) {
    const key = file.replace(/\.json$/, "");
    const exists = await query("select 1 from panels where seed_key = $1", [key]);
    if (exists.rowCount) continue;
    const spec = JSON.parse(fs.readFileSync(path.join(samplesDir, file), "utf8"));
    const { steps } = plan(spec);
    await tx(async (c) => {
      const p = await c.query("insert into panels (name, locked, seed_key) values ($1, true, $2) returning id", [spec.name, key]);
      await c.query(
        `insert into revisions (panel_id, rev, spec, steps, status, released_at)
         values ($1, 1, $2, $3, 'released', now())`,
        [p.rows[0].id, spec, JSON.stringify(steps)],
      );
    });
    console.log(`seeded ${key}`);
  }
}
