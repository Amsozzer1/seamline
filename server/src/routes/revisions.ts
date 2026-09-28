import { Router } from "express";
import { z } from "zod";
import { activeLoops, startRun } from "../cell.js";
import { check, hasErrors } from "../core.js";
import { query, tx } from "../db.js";
import { body, conflict, HttpError, id, invalid, notFound } from "../http.js";

export const revisions = Router();

async function load(revisionId: string) {
  const r = await query(
    `select v.*, p.name as panel_name, p.locked from revisions v join panels p on p.id = v.panel_id where v.id = $1`,
    [revisionId],
  );
  if (!r.rowCount) throw notFound("Revision");
  return r.rows[0];
}

revisions.get("/revisions/:id", async (req, res) => {
  const v = await load(id(req));
  const [siblings, runs] = await Promise.all([
    query("select id, rev, status from revisions where panel_id = $1 order by rev", [v.panel_id]),
    query("select id, status, created_at from runs where revision_id = $1 order by created_at desc limit 10", [v.id]),
  ]);
  res.json({
    id: v.id,
    rev: v.rev,
    status: v.status,
    spec: v.spec,
    steps: v.steps,
    created_at: v.created_at,
    released_at: v.released_at,
    panel: { id: v.panel_id, name: v.panel_name, locked: v.locked },
    revisions: siblings.rows,
    runs: runs.rows,
  });
});

const StepSchema = z.object({
  kind: z.enum(["tack", "weld"]),
  seam_id: z.string().max(64),
  portion: z.enum(["full", "first_half", "second_half"]),
  direction: z.enum(["forward", "reverse"]),
});

revisions.put("/revisions/:id", async (req, res) => {
  const revisionId = id(req);
  const { spec, steps } = body(
    z.object({ spec: z.object({ name: z.string().min(1).max(80) }).passthrough(), steps: z.array(StepSchema).max(1000) }),
    req,
  );
  const issues = check(spec, steps);
  if (hasErrors(issues)) throw invalid("Plan has errors", issues);
  const r = await query(
    `update revisions set spec = $2, steps = $3 where id = $1 and status = 'draft' returning id`,
    [revisionId, spec, JSON.stringify(steps)],
  );
  if (!r.rowCount) {
    await load(revisionId); // 404 if missing
    throw conflict("Released revisions cannot be edited. Create a new revision.");
  }
  await query("update panels set name = $2 where id = (select panel_id from revisions where id = $1)", [revisionId, spec.name]);
  res.json({ ok: true, issues });
});

revisions.post("/revisions/:id/release", async (req, res) => {
  const v = await load(id(req));
  if (v.status !== "draft") throw conflict("Only a draft can be released.");
  const issues = check(v.spec, v.steps);
  if (hasErrors(issues)) throw invalid("Plan has errors", issues);
  const r = await query(
    `update revisions set status = 'released', released_at = now() where id = $1 and status = 'draft' returning id`,
    [v.id],
  );
  if (!r.rowCount) throw conflict("Only a draft can be released.");
  res.json({ ok: true });
});

revisions.post("/revisions/:id/revise", async (req, res) => {
  const v = await load(id(req));
  if (v.locked) throw conflict("Sample panels are locked. Duplicate the panel to edit it.");
  if (v.status !== "released") throw conflict("Only a released revision can be revised.");
  const draft = await query("select id from revisions where panel_id = $1 and status = 'draft'", [v.panel_id]);
  if (draft.rowCount) throw conflict("This panel already has a draft.", { revision_id: draft.rows[0].id });
  const out = await tx(async (c) => {
    const next = await c.query("select coalesce(max(rev), 0) + 1 as rev from revisions where panel_id = $1", [v.panel_id]);
    const r = await c.query(
      `insert into revisions (panel_id, rev, spec, steps, status) values ($1, $2, $3, $4, 'draft') returning id`,
      [v.panel_id, next.rows[0].rev, v.spec, JSON.stringify(v.steps)],
    );
    return { revision_id: r.rows[0].id };
  });
  res.status(201).json(out);
});

const MAX_ACTIVE_RUNS = 5;

revisions.post("/revisions/:id/runs", async (req, res) => {
  const { speed } = body(z.object({ speed: z.union([z.literal(1), z.literal(4), z.literal(10)]).default(4) }), req);
  const v = await load(id(req));
  if (v.status !== "released") throw conflict("Only a released plan can be run.");
  const running = await query("select id from runs where revision_id = $1 and status = 'running'", [v.id]);
  if (running.rowCount) throw conflict("The cell is already running this plan.", { run_id: running.rows[0].id });
  if (activeLoops() >= MAX_ACTIVE_RUNS) throw new HttpError(429, "The demo cell is busy. Try again in a minute.");
  const run = await startRun(v.id, speed);
  res.status(201).json({ run_id: run.id });
});
