import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText, useRun } from "../api";
import { plan, portionLabel, stepDurationMs } from "../core";
import type { Run, RunEvent } from "../types";
import { useRunStream } from "../useRunStream";
import { Legend, SeamInfo } from "../viewer/Overlays";
import { PanelScene } from "../viewer/PanelScene";
import { seamSegments } from "../viewer/seamState";

export function OperatorPage() {
  const { id } = useParams();
  const q = useRun(id!);
  if (q.isPending) return <p className="page muted">Loading run…</p>;
  if (q.isError) return <p className="page error">{errorText(q.error)}</p>;
  return <Operator run={q.data} />;
}

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function describe(e: RunEvent, run: Run) {
  const step = e.step !== null ? run.steps[e.step] : undefined;
  const label = step ? `${e.step! + 1} ${step.seam_id} ${portionLabel(step)}` : "";
  switch (e.kind) {
    case "started":
      return `Run started at ${e.detail.speed}×`;
    case "step_started":
      return `Start ${label}`;
    case "step_done":
      return `Done  ${label}`;
    case "fault":
      return `FAULT ${label}: ${e.detail.reason}`;
    case "retry":
      return `Retry ${label}`;
    case "skip":
      return `Skip  ${label}: ${e.detail.reason}`;
    case "complete":
      return "Run complete";
  }
}

function Operator({ run }: { run: Run }) {
  const { view, online } = useRunStream(run.id);
  const seams = useMemo(() => plan(run.spec).seams, [run.spec]);
  const seamMap = useMemo(() => new Map(seams.map((s) => [s.id, s])), [seams]);
  const [now, setNow] = useState(Date.now());
  const [hover, setHover] = useState<string | null>(null);
  const [showJoints, setShowJoints] = useState(true);
  const [skipReason, setSkipReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const total = run.steps.length;
  const complete = view.status === "complete";
  const cursor = complete ? total : view.current;
  const step = run.steps[cursor];
  const seam = step ? seamMap.get(step.seam_id) : undefined;
  const done = complete ? total : view.current;
  const current = view.status === "faulted" ? "faulted" : view.status === "running" ? "active" : "pending";
  const segments = useMemo(() => seamSegments(run.steps, cursor, current, view.skipped), [run.steps, cursor, current, view.skipped]);
  const elapsed = view.startedAt ? (view.finishedAt ?? now) - view.startedAt : 0;
  const remainingMs = run.steps.slice(cursor).reduce((acc, s) => acc + stepDurationMs(s, seamMap.get(s.seam_id), run.speed), 0);

  const torch =
    view.status === "running" && step && seam
      ? { step, seam, startedAt: view.currentSince, durationMs: stepDurationMs(step, seam, run.speed) }
      : null;

  async function act(action: "retry" | "skip") {
    setBusy(true);
    setActionError(null);
    try {
      await api.act(run.id, action, action === "skip" ? skipReason : undefined);
      setSkipReason("");
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page operator">
      <header className="pagehead">
        <div>
          <div className="crumbs">
            <Link to="/">Panels</Link> / <Link to={`/revisions/${run.revision_id}`}>{run.panel_name} rev {run.rev}</Link> / run
          </div>
          <h1>
            Cell 1 <span className={`status status-${view.status}`}>{view.status}</span>
            {!online && view.status !== "complete" && <span className="status status-faulted">reconnecting</span>}
          </h1>
        </div>
        <div className="op-clock">
          <div>
            <span className="muted">elapsed</span> <span className="mono">{clock(elapsed)}</span>
          </div>
          <div>
            <span className="muted">remaining</span> <span className="mono">{complete ? "0:00" : clock(remainingMs)}</span>
          </div>
          <div>
            <span className="muted">speed</span> <span className="mono">{run.speed}×</span>
          </div>
        </div>
      </header>

      {view.fault && (
        <div className="fault" role="alert">
          <div>
            <strong>Fault on step {view.fault.step + 1}</strong> ({run.steps[view.fault.step]?.seam_id}): {view.fault.reason}
          </div>
          <div className="fault-actions">
            <button className="primary" disabled={busy} onClick={() => act("retry")}>
              Retry step
            </button>
            <input
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              placeholder="Reason for skipping (required)"
              maxLength={200}
            />
            <button disabled={busy || !skipReason.trim()} onClick={() => act("skip")}>
              Skip step
            </button>
          </div>
          {actionError && <div className="error">{actionError}</div>}
        </div>
      )}

      <div className="now">
        <div className="now-step">
          {complete ? (
            <span>All {total} steps complete</span>
          ) : step ? (
            <>
              <span className="muted">Step {cursor + 1} of {total}</span>
              <span className="now-seam mono">{step.seam_id}</span>
              <span>{portionLabel(step)}</span>
              {seam && <span className="muted">{Math.round(step.portion === "full" ? seam.length_mm : seam.length_mm / 2)} mm</span>}
            </>
          ) : (
            <span className="muted">Waiting for the cell…</span>
          )}
        </div>
        <div className="progress" aria-label={`${done} of ${total} steps done`}>
          <div style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
        </div>
      </div>

      <div className="workspace">
        <section className="viewer">
          <PanelScene spec={run.spec} seams={seams} segments={segments} highlight={hover} showJoints={showJoints} torch={torch} onHover={setHover} />
          <Legend running hasJoints={seams.some((s) => s.kind === "joint")} showJoints={showJoints} onToggleJoints={() => setShowJoints((v) => !v)} />
          <SeamInfo seam={hover ? seamMap.get(hover) : undefined} />
        </section>
        <aside className="side">
          <h2>Event log</h2>
          <ol className="log mono">
            {[...view.events].reverse().slice(0, 200).map((e) => (
              <li key={e.id} className={`log-${e.kind}`}>
                <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {describe(e, run)}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
