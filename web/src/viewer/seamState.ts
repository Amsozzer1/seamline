import type { Step } from "../types";
import type { SeamState } from "./PanelScene";

/**
 * Colour every seam by where a plan is: steps before `cursor` are done, the step at
 * `cursor` is active, the rest are pending. A seam welded in halves counts as done
 * only when both halves are.
 */
export function seamStates(
  steps: Step[],
  cursor: number,
  skipped: Set<number> = new Set(),
  markActive = true,
): Map<string, SeamState> {
  const out = new Map<string, SeamState>();
  const remaining = new Map<string, number>();
  for (const s of steps) if (s.kind === "weld") remaining.set(s.seam_id, (remaining.get(s.seam_id) ?? 0) + 1);
  for (const s of steps) out.set(s.seam_id, "pending");

  steps.forEach((s, i) => {
    if (i >= cursor || s.kind !== "weld") return;
    if (skipped.has(i)) {
      out.set(s.seam_id, "skipped");
      remaining.set(s.seam_id, -Infinity);
      return;
    }
    const left = (remaining.get(s.seam_id) ?? 1) - 1;
    remaining.set(s.seam_id, left);
    if (left === 0) out.set(s.seam_id, "done");
  });
  const current = steps[cursor];
  if (current && markActive) out.set(current.seam_id, "active");
  return out;
}
