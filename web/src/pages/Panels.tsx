import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorText, usePanels, useSamples } from "../api";
import { hasErrors, plan } from "../core";

function ago(iso: string) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function PanelsPage() {
  const panels = usePanels();
  const samples = useSamples();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [sample, setSample] = useState("");
  const [error, setError] = useState<string | null>(null);
  const valid = useMemo(() => (samples.data ?? []).filter((s) => !hasErrors(plan(s.spec).issues)), [samples.data]);

  async function create() {
    const s = valid.find((v) => v.key === sample);
    if (!s) return;
    setError(null);
    try {
      const r = await api.createPanel({ ...s.spec, name: `${s.spec.name} (new)` });
      qc.invalidateQueries({ queryKey: ["panels"] });
      navigate(`/revisions/${r.revision_id}`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function reset() {
    if (!confirm("Reset the demo? This deletes every panel and run that is not a sample.")) return;
    await api.reset();
    qc.invalidateQueries();
  }

  return (
    <div className="page panels">
      <header className="pagehead">
        <div>
          <h1>Panels</h1>
          <p className="lede">
            Stiffened steel panels, their weld plans, and runs on a simulated weld cell. Open a panel to see its seams and
            sequence in 3D, or start a run to watch the cell work through it.
          </p>
        </div>
        <div className="actions">
          <select value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample">
            <option value="">New panel from sample…</option>
            {valid.map((s) => (
              <option key={s.key} value={s.key}>
                {s.spec.name}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!sample} onClick={create}>
            Create
          </button>
        </div>
      </header>
      {error && <p className="banner banner-error">{error}</p>}
      {panels.isPending && <p className="muted">Loading…</p>}
      {panels.isError && <p className="error">{errorText(panels.error)}</p>}
      {panels.data && (
        <table className="table">
          <thead>
            <tr>
              <th>Panel</th>
              <th>Revision</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {panels.data.map((p) => (
              <tr key={p.id} onClick={() => navigate(`/revisions/${p.revision_id}`)}>
                <td>
                  <Link to={`/revisions/${p.revision_id}`}>{p.name}</Link>
                  {p.locked && <span className="status">sample</span>}
                </td>
                <td className="mono">rev {p.rev}</td>
                <td>
                  <span className={`status status-${p.status}`}>{p.status}</span>
                </td>
                <td className="muted">{ago(p.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <footer className="pagefoot muted">
        This is a public demo; anyone can edit it.{" "}
        <button className="link" onClick={reset}>
          Reset demo data
        </button>
      </footer>
    </div>
  );
}
