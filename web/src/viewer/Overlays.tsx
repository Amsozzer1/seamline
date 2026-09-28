import type { Seam } from "../types";
import { COLORS } from "./PanelScene";

export function Legend({ showJoints, onToggleJoints, running, hasJoints = true }: {
  showJoints: boolean;
  onToggleJoints: () => void;
  running?: boolean;
  hasJoints?: boolean;
}) {
  const items = running
    ? [
        ["Welding", COLORS.active],
        ["Done", COLORS.done],
        ["To weld", COLORS.pending],
        ["Fault / skipped", COLORS.faulted],
      ]
    : [
        ["Fillet (stiffener to plate)", COLORS.fillet],
        ...(hasJoints ? [["Joint (stiffener to stiffener)", COLORS.joint]] : []),
      ];
  return (
    <div className="legend">
      {items.map(([label, color]) => (
        <span key={label}>
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
      {hasJoints && (
        <label>
          <input type="checkbox" checked={showJoints} onChange={onToggleJoints} /> joints
        </label>
      )}
    </div>
  );
}

export function SeamInfo({ seam }: { seam?: Seam }) {
  if (!seam) return <div className="seaminfo muted">Hover a seam for details · drag to orbit · scroll to zoom</div>;
  return (
    <div className="seaminfo">
      <span className="mono">{seam.id}</span> · {seam.kind} · {Math.round(seam.length_mm)} mm · joins {seam.parts[0]} and{" "}
      {seam.parts[1].toLowerCase() === "plate" ? "plate" : seam.parts[1]}
    </div>
  );
}
