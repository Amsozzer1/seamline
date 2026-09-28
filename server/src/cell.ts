import { EventEmitter } from "node:events";
import type pg from "pg";
import { plan, type Seam, type Step } from "./core.js";
import { query, tx } from "./db.js";

/**
 * A simulated weld cell. It walks a released plan one step at a time, sleeping in
 * proportion to seam length, and reports progress as events. Every event is written to
 * run_events first and then published to live listeners, so the event log in Postgres
 * is the source of truth and a browser can always replay it.
 *
 * The loop holds no state that matters: status and current_step live in the runs row.
 * A fault ends the loop; an operator action flips the row back to running and starts a
 * fresh loop from current_step. That makes a server restart just another fault.
 */

export type RunEvent = { id: number; run_id: string; kind: string; step: number | null; detail: any; at: string };

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const TACK_MS = 400;
const WELD_MS_PER_MM = 0.5;
const MIN_WELD_MS = 600;
export const SCRIPTED_FAULT = "Arc lost: wire feed stall";

const loops = new Map<string, AbortController>();
export const activeLoops = () => loops.size;

async function emit(c: pg.PoolClient | null, runId: string, kind: string, step: number | null, detail: object = {}) {
  const sql = `insert into run_events (run_id, kind, step, detail) values ($1, $2, $3, $4) returning *`;
  const params = [runId, kind, step, detail];
  const row = (c ? await c.query(sql, params) : await query(sql, params)).rows[0] as RunEvent;
  return row;
}

const publish = (ev: RunEvent) => bus.emit(ev.run_id, ev);

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

export function stepDuration(step: Step, seam: Seam | undefined): number {
  if (step.kind === "tack" || !seam) return TACK_MS;
  const len = step.portion === "full" ? seam.length_mm : seam.length_mm / 2;
  return Math.max(MIN_WELD_MS, len * WELD_MS_PER_MM);
}

/** Index of the step the demo always faults on: the third weld, or the last if fewer. */
export function scriptedFaultStep(steps: Step[]): number {
  const welds = steps.map((s, i) => (s.kind === "weld" ? i : -1)).filter((i) => i >= 0);
  return welds[Math.min(2, welds.length - 1)] ?? -1;
}

/** Record a fault in the same transaction as the status change, then publish it. */
export async function fault(runId: string, step: number, reason: string, scripted = false) {
  const ev = await tx(async (c) => {
    const r = await c.query(`update runs set status = 'faulted' where id = $1 and status = 'running' returning id`, [runId]);
    if (!r.rowCount) return null;
    return emit(c, runId, "fault", step, { reason, scripted });
  });
  if (ev) publish(ev);
}

export function startLoop(runId: string) {
  if (loops.has(runId)) return;
  const ctl = new AbortController();
  loops.set(runId, ctl);
  runLoop(runId, ctl.signal)
    .catch(async (err) => {
      if (ctl.signal.aborted) return;
      console.error(`cell loop ${runId} failed`, err);
      const r = await query("select current_step from runs where id = $1", [runId]).catch(() => null);
      await fault(runId, r?.rows[0]?.current_step ?? 0, "Internal error in cell controller").catch(() => {});
    })
    .finally(() => {
      if (loops.get(runId) === ctl) loops.delete(runId);
    });
}

async function runLoop(runId: string, signal: AbortSignal) {
  const r = await query(
    `select r.speed, v.spec, v.steps,
            exists (select 1 from run_events e where e.run_id = r.id and e.kind = 'fault'
                    and (e.detail->>'scripted')::boolean) as fault_fired
       from runs r join revisions v on v.id = r.revision_id where r.id = $1`,
    [runId],
  );
  if (!r.rowCount) return;
  const { speed, spec, steps, fault_fired } = r.rows[0] as { speed: number; spec: unknown; steps: Step[]; fault_fired: boolean };
  const seams = new Map(plan(spec).seams.map((s) => [s.id, s]));
  const faultAt = fault_fired ? -1 : scriptedFaultStep(steps);

  while (!signal.aborted) {
    const run = (await query("select status, current_step from runs where id = $1", [runId])).rows[0];
    if (!run || run.status !== "running") return;
    const i: number = run.current_step;

    if (i >= steps.length) {
      const ev = await tx(async (c) => {
        const u = await c.query(`update runs set status = 'complete', finished_at = now() where id = $1 and status = 'running' returning id`, [runId]);
        return u.rowCount ? emit(c, runId, "complete", null) : null;
      });
      if (ev) publish(ev);
      return;
    }

    const step = steps[i];
    publish(await emit(null, runId, "step_started", i, { seam_id: step.seam_id, kind: step.kind, portion: step.portion }));
    const ms = stepDuration(step, seams.get(step.seam_id)) / speed;

    if (i === faultAt) {
      await sleep(ms * 0.4, signal);
      await fault(runId, i, SCRIPTED_FAULT, true);
      return;
    }
    await sleep(ms, signal);

    // Advance and record completion atomically, but only if nobody changed the run meanwhile.
    const ev = await tx(async (c) => {
      const u = await c.query(
        `update runs set current_step = $2 where id = $1 and status = 'running' and current_step = $3 returning id`,
        [runId, i + 1, i],
      );
      return u.rowCount ? emit(c, runId, "step_done", i, { seam_id: step.seam_id }) : null;
    });
    if (!ev) return;
    publish(ev);
  }
}

/**
 * Operator action on a faulted run. The conditional update means that when two
 * operators click at once, exactly one of them resumes the cell.
 */
export async function act(runId: string, action: "retry" | "skip", reason?: string) {
  const ev = await tx(async (c) => {
    const sql =
      action === "retry"
        ? `update runs set status = 'running' where id = $1 and status = 'faulted' returning current_step`
        : `update runs set status = 'running', current_step = current_step + 1 where id = $1 and status = 'faulted' returning current_step - 1 as current_step`;
    const u = await c.query(sql, [runId]);
    if (!u.rowCount) return null;
    return emit(c, runId, action, u.rows[0].current_step, reason ? { reason } : {});
  });
  if (!ev) return false;
  publish(ev);
  startLoop(runId);
  return true;
}

export async function startRun(revisionId: string, speed: number) {
  const run = await tx(async (c) => {
    // A new run supersedes an abandoned faulted one; a run still moving blocks.
    await c.query(
      `update runs set status = 'aborted', finished_at = now() where revision_id = $1 and status = 'faulted'`,
      [revisionId],
    );
    const r = await c.query(`insert into runs (revision_id, status, speed) values ($1, 'running', $2) returning *`, [revisionId, speed]);
    await emit(c, r.rows[0].id, "started", 0, { speed });
    return r.rows[0];
  });
  startLoop(run.id);
  return run;
}

/** On boot, any run that was mid-step when the process died is reported as a fault. */
export async function recoverAfterRestart() {
  const r = await query(`select id, current_step from runs where status = 'running'`);
  for (const row of r.rows) {
    await fault(row.id, row.current_step, "Cell restarted: controller lost power mid-step");
  }
  if (r.rowCount) console.log(`marked ${r.rowCount} interrupted run(s) as faulted`);
}

export function abortAll() {
  for (const ctl of loops.values()) ctl.abort(new Error("reset"));
  loops.clear();
}
