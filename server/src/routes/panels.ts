import { Router } from "express";
import { z } from "zod";
import { abortAll } from "../cell.js";
import { hasErrors, plan } from "../core.js";
import { query, tx } from "../db.js";
import { body, id, invalid, notFound } from "../http.js";
import { ensureSeeds, sampleSpecs } from "../seed.js";

export const panels = Router();

panels.get("/panels", async (_req, res) => {
  const r = await query(`
    select p.id, p.name, p.locked, p.created_at,
           v.id as revision_id, v.rev, v.status, greatest(v.created_at, v.released_at) as updated_at
      from panels p
      join lateral (select * from revisions where panel_id = p.id order by rev desc limit 1) v on true
     order by p.locked desc, p.created_at desc`);
  res.json(r.rows);
});

panels.get("/samples", (_req, res) => {
  res.json(sampleSpecs());
});

async function createPanel(spec: unknown, name: string) {
  const p = plan(spec);
  if (hasErrors(p.issues)) throw invalid("Spec has errors", p.issues);
  return tx(async (c) => {
    const panel = await c.query("insert into panels (name) values ($1) returning id", [name]);
    const rev = await c.query(
      `insert into revisions (panel_id, rev, spec, steps, status) values ($1, 1, $2, $3, 'draft') returning id`,
      [panel.rows[0].id, spec, JSON.stringify(p.steps)],
    );
    return { panel_id: panel.rows[0].id, revision_id: rev.rows[0].id };
  });
}

panels.post("/panels", async (req, res) => {
  const { spec } = body(z.object({ spec: z.object({ name: z.string().min(1).max(80) }).passthrough() }), req);
  res.status(201).json(await createPanel(spec, spec.name));
});

/** Seeded panels are locked; duplicating one is how a visitor gets an editable copy. */
panels.post("/panels/:id/duplicate", async (req, res) => {
  const r = await query(
    `select p.name, v.spec, v.steps from panels p
       join lateral (select * from revisions where panel_id = p.id order by rev desc limit 1) v on true
      where p.id = $1`,
    [id(req)],
  );
  if (!r.rowCount) throw notFound("Panel");
  const { name, spec, steps } = r.rows[0];
  const copyName = `${name} (copy)`.slice(0, 80);
  const out = await tx(async (c) => {
    const panel = await c.query("insert into panels (name) values ($1) returning id", [copyName]);
    const rev = await c.query(
      `insert into revisions (panel_id, rev, spec, steps, status) values ($1, 1, $2, $3, 'draft') returning id`,
      [panel.rows[0].id, { ...spec, name: copyName }, JSON.stringify(steps)],
    );
    return { panel_id: panel.rows[0].id, revision_id: rev.rows[0].id };
  });
  res.status(201).json(out);
});

/** Put the public demo back to its seeded state. */
panels.post("/demo/reset", async (_req, res) => {
  abortAll();
  await query("delete from runs");
  await query("delete from panels where seed_key is null");
  await ensureSeeds();
  res.json({ ok: true });
});
