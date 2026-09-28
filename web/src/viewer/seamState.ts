import type { Step } from "../types";

export type SegmentState = "pending" | "active" | "faulted" | "done" | "skipped";
/** A stretch of one seam, as fractions of its length, in one state. */
export type Segment = { from: number; to: number; state: SegmentState };

const RANGE: Record<Step["portion"], [number, number]> = {
  full: [0, 1],
  first_half: [0, 0.5],
  second_half: [0.5, 1],
};

/**
 * What every seam looks like at a point in the plan. Seams welded in halves are drawn
 * half by half, so a finished first half shows as done while the second is still
 * pending, active or faulted. Steps before `cursor` are done (or skipped), the step at
 * `cursor` takes `current`, the rest are pending.
 */
export function seamSegments(
  steps: Step[],
  cursor: number,
  current: "active" | "faulted" | "pending" = "active",
  skipped: Set<number> = new Set(),
): Map<string, Segment[]> {
  const out = new Map<string, Segment[]>();
  steps.forEach((s, i) => {
    if (s.kind !== "weld") return;
    const [from, to] = RANGE[s.portion];
    const state: SegmentState = i < cursor ? (skipped.has(i) ? "skipped" : "done") : i === cursor ? current : "pending";
    const list = out.get(s.seam_id) ?? [];
    list.push({ from, to, state });
    out.set(s.seam_id, list);
  });
  // While the cursor is on a tack, show that seam as active along its whole length.
  const step = steps[cursor];
  if (step?.kind === "tack" && current !== "pending") {
    out.set(step.seam_id, [{ from: 0, to: 1, state: current }]);
  }
  return out;
}
