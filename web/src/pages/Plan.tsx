import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, errorText, useRevision } from "../api";
import { check, hasErrors, planFromText } from "../core";
import { StepList } from "../plan/StepList";
import type { Issue, Revision, Spec, Step } from "../types";
import { PanelScene } from "../viewer/PanelScene";
import { seamSegments } from "../viewer/seamState";
import { SeamInfo, Legend } from "../viewer/Overlays";

export function PlanPage() {
  const { id } = useParams();
  const q = useRevision(id!);
  if (q.isPending) return <p className="page muted">Loading plan…</p>;
  if (q.isError) return <p className="page error">{errorText(q.error)}</p>;
  return <PlanEditor key={`${q.data.id}:${q.data.status}`} rev={q.data} />;
}

const canonical = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
};

function looksLikeSpec(v: any): v is Spec {
  return v && typeof v === "object" && v.plate && typeof v.plate.length_mm === "number" && Array.isArray(v.stiffeners);
}

function PlanEditor({ rev }: { rev: Revision }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editable = rev.status === "draft";

  const [specText, setSpecText] = useState(() => JSON.stringify(rev.spec, null, 2));
  const [debounced, setDebounced] = useState(specText);
  const [steps, setSteps] = useState<Step[]>(rev.steps);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showJoints, setShowJoints] = useState(true);
  const [showSpec, setShowSpec] = useState(false);
  const [speed, setSpeed] = useState(4);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(specText), 200);
    return () => clearTimeout(t);
  }, [specText]);

  const planned = useMemo(() => planFromText(debounced), [debounced]);
  const parsed = useMemo(() => {
    try {
      return JSON.parse(debounced);
    } catch {
      return null;
    }
  }, [debounced]);

  // Keep the last spec that could be drawn, so a half-typed edit does not blank the viewer.
  const lastDrawable = useRef<Spec>(rev.spec);
  if (looksLikeSpec(parsed)) lastDrawable.current = parsed;
  const drawSpec = lastDrawable.current;

  // A changed spec means different seams: the edited order no longer applies.
  const appliedSpec = useRef(canonical(debounced));
  useEffect(() => {
    const key = canonical(debounced);
    if (key === appliedSpec.current || hasErrors(planned.issues)) return;
    appliedSpec.current = key;
    setSteps(planned.steps);
    setCursor(null);
    setNotice("The spec changed, so the step order was reset to the default sequence.");
  }, [debounced, planned]);

  const specOk = !hasErrors(planned.issues);
  const issues: Issue[] = useMemo(() => (specOk ? check(parsed, steps) : planned.issues), [specOk, parsed, steps, planned]);
  const errors = hasErrors(issues);
  const seams = planned.seams;
  const seamMap = useMemo(() => new Map(seams.map((s) => [s.id, s])), [seams]);
  const badParts = useMemo(() => new Set(issues.filter((i) => i.part_id).map((i) => i.part_id!)), [issues]);
  const dirty = canonical(specText) !== JSON.stringify(rev.spec) || JSON.stringify(steps) !== JSON.stringify(rev.steps);

  // Scrubber playback.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setCursor((c) => {
        const next = (c ?? -1) + 1;
        if (next >= steps.length) {
          setPlaying(false);
          return steps.length;
        }
        return next;
      });
    }, 90);
    return () => clearInterval(t);
  }, [playing, steps.length]);

  const segments = cursor === null ? undefined : seamSegments(steps, cursor);

  async function run<T>(fn: () => Promise<T>, after?: (v: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      after?.(v);
    } catch (e) {
      if (e instanceof ApiError && e.data?.run_id) return navigate(`/runs/${e.data.run_id}`);
      if (e instanceof ApiError && e.data?.revision_id) return navigate(`/revisions/${e.data.revision_id}`);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["revision"] });
    qc.invalidateQueries({ queryKey: ["panels"] });
  };

  return (
    <div className="page plan">
      <header className="pagehead">
        <div>
          <div className="crumbs">
            <Link to="/">Panels</Link> / {rev.panel.name}
          </div>
          <h1>
            {rev.panel.name} <span className="rev">rev {rev.rev}</span>{" "}
            <span className={`status status-${rev.status}`}>{rev.status}</span>
            {rev.panel.locked && <span className="status">sample</span>}
          </h1>
          <div className="meta">
            {rev.revisions.length > 1 &&
              rev.revisions.map((r) => (
                <Link key={r.id} to={`/revisions/${r.id}`} className={r.id === rev.id ? "current" : ""}>
                  rev {r.rev}
                </Link>
              ))}
            <span>
              {seams.length} seams · {steps.length} steps
            </span>
          </div>
        </div>
        <div className="actions">
          {editable ? (
            <>
              <button disabled={busy || !dirty || errors || specText !== debounced} onClick={() => run(() => api.save(rev.id, parsed, steps), refresh)}>
                Save
              </button>
              <button disabled={busy} onClick={() => { setSteps(planned.steps); setNotice(null); }}>
                Reset order
              </button>
              <button
                className="primary"
                disabled={busy || dirty || errors}
                title={dirty ? "Save before releasing" : undefined}
                onClick={() => run(() => api.release(rev.id), refresh)}
              >
                Release
              </button>
            </>
          ) : (
            <>
              {rev.panel.locked ? (
                <button disabled={busy} onClick={() => run(() => api.duplicate(rev.panel.id), (r) => { refresh(); navigate(`/revisions/${r.revision_id}`); })}>
                  Duplicate to edit
                </button>
              ) : (
                <button disabled={busy} onClick={() => run(() => api.revise(rev.id), (r) => { refresh(); navigate(`/revisions/${r.revision_id}`); })}>
                  New revision
                </button>
              )}
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Cell speed">
                <option value={1}>1×</option>
                <option value={4}>4×</option>
                <option value={10}>10×</option>
              </select>
              <button className="primary" disabled={busy} onClick={() => run(() => api.startRun(rev.id, speed), (r) => navigate(`/runs/${r.run_id}`))}>
                Start run
              </button>
            </>
          )}
        </div>
      </header>

      {error && <p className="banner banner-error">{error}</p>}
      {notice && editable && (
        <p className="banner">
          {notice} <button className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      <div className="workspace">
        <section className="viewer">
          <PanelScene
            spec={drawSpec}
            seams={seams}
            segments={segments}
            highlight={hover}
            highlightParts={badParts}
            showJoints={showJoints}
            onHover={setHover}
          />
          <Legend showJoints={showJoints} hasJoints={seams.some((s) => s.kind === "joint")} onToggleJoints={() => setShowJoints((v) => !v)} />
          <SeamInfo seam={hover ? seamMap.get(hover) : undefined} />
          <div className="scrubber">
            <button
              onClick={() => {
                if (cursor !== null && cursor >= steps.length) setCursor(-1);
                setPlaying((p) => !p);
              }}
              disabled={!steps.length || errors}
            >
              {playing ? "Pause" : "Preview"}
            </button>
            <input
              type="range"
              min={-1}
              max={steps.length}
              value={cursor ?? -1}
              onChange={(e) => {
                setPlaying(false);
                const v = Number(e.target.value);
                setCursor(v < 0 ? null : v);
              }}
              aria-label="Sequence position"
            />
            <span className="mono muted">{cursor === null ? "–" : `${Math.min(cursor + 1, steps.length)}/${steps.length}`}</span>
          </div>
        </section>

        <aside className="side">
          {issues.length > 0 && (
            <section>
              <h2>Validation</h2>
              <ul className="issues">
                {issues.map((i, n) => (
                  <li key={n} className={`issue issue-${i.severity}`}>
                    <span className="issue-sev">{i.severity}</span> {i.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2>Sequence</h2>
            {specOk ? (
              <StepList
                steps={steps}
                seams={seamMap}
                editable={editable}
                cursor={cursor}
                highlight={hover}
                onChange={(s) => { setSteps(s); setCursor(null); }}
                onHover={setHover}
              />
            ) : (
              <p className="muted">Fix the spec errors to generate a sequence.</p>
            )}
          </section>
          <section>
            <button className="phase" onClick={() => setShowSpec((v) => !v)} aria-expanded={showSpec}>
              <span>{showSpec ? "▾" : "▸"} Panel spec (JSON)</span>
              <span className="muted">{editable ? "editable" : "read-only"}</span>
            </button>
            {showSpec && (
              <textarea
                className="spec mono"
                value={specText}
                readOnly={!editable}
                spellCheck={false}
                onChange={(e) => setSpecText(e.target.value)}
                rows={22}
              />
            )}
          </section>
          {rev.runs.length > 0 && (
            <section>
              <h2>Runs</h2>
              <ul className="runs">
                {rev.runs.map((r) => (
                  <li key={r.id}>
                    <Link to={`/runs/${r.id}`}>{new Date(r.created_at).toLocaleString()}</Link>{" "}
                    <span className={`status status-${r.status}`}>{r.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
