import { Router } from "express";
import { z } from "zod";
import { act, bus, type RunEvent } from "../cell.js";
import { query } from "../db.js";
import { body, conflict, id, invalid, notFound } from "../http.js";

export const runs = Router();

runs.get("/runs/:id", async (req, res) => {
  const r = await query(
    `select r.id, r.status, r.current_step, r.speed, r.created_at, r.finished_at,
            v.id as revision_id, v.rev, v.spec, v.steps, p.id as panel_id, p.name as panel_name
       from runs r join revisions v on v.id = r.revision_id join panels p on p.id = v.panel_id
      where r.id = $1`,
    [id(req)],
  );
  if (!r.rowCount) throw notFound("Run");
  res.json(r.rows[0]);
});

runs.post("/runs/:id/actions", async (req, res) => {
  const runId = id(req);
  const { action, reason } = body(
    z.object({ action: z.enum(["retry", "skip"]), reason: z.string().trim().max(200).optional() }),
    req,
  );
  if (action === "skip" && !reason) throw invalid("Skipping a step requires a reason.");
  const ok = await act(runId, action, reason);
  if (!ok) {
    const r = await query("select status from runs where id = $1", [runId]);
    if (!r.rowCount) throw notFound("Run");
    throw conflict(`Run is ${r.rows[0].status}; ${action} only applies to a faulted run.`);
  }
  res.json({ ok: true });
});

/**
 * Server-sent events. Replays everything after Last-Event-ID, then streams live.
 * Subscribe before querying so nothing written in between is lost; de-duplicate by id.
 */
runs.get("/runs/:id/stream", async (req, res) => {
  const runId = id(req);
  const exists = await query("select 1 from runs where id = $1", [runId]);
  if (!exists.rowCount) throw notFound("Run");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let lastSent = Number(req.headers["last-event-id"] ?? 0) || 0;
  let replaying = true;
  const pending: RunEvent[] = [];
  const send = (ev: RunEvent) => {
    if (ev.id <= lastSent) return;
    lastSent = ev.id;
    res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const onEvent = (ev: RunEvent) => (replaying ? pending.push(ev) : send(ev));
  bus.on(runId, onEvent);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    bus.off(runId, onEvent);
  });

  const past = await query<RunEvent>("select * from run_events where run_id = $1 and id > $2 order by id", [runId, lastSent]);
  for (const ev of past.rows) send({ ...ev, id: Number(ev.id) });
  replaying = false;
  for (const ev of pending) send({ ...ev, id: Number(ev.id) });
});
