import { useEffect, useReducer, useState } from "react";
import type { RunEvent, RunStatus } from "./types";

export type RunView = {
  status: RunStatus | "connecting";
  current: number;
  /** When the current step started, in client ms. */
  currentSince: number;
  skipped: Set<number>;
  fault: { step: number; reason: string } | null;
  events: RunEvent[];
  startedAt: number | null;
  finishedAt: number | null;
};

const initial: RunView = {
  status: "connecting",
  current: 0,
  currentSince: Date.now(),
  skipped: new Set(),
  fault: null,
  events: [],
  startedAt: null,
  finishedAt: null,
};

/** Fold the cell's event log into what the operator screen shows. Replayed and live events go through the same path. */
function reduce(v: RunView, e: RunEvent): RunView {
  if (v.events.length && e.id <= v.events[v.events.length - 1].id) return v;
  const at = Date.parse(e.at);
  const next: RunView = { ...v, events: [...v.events, e] };
  switch (e.kind) {
    case "started":
      return { ...next, status: "running", startedAt: at };
    case "step_started":
      return { ...next, status: "running", current: e.step!, currentSince: Math.min(at, Date.now()) };
    case "step_done":
      return { ...next, current: e.step! + 1, currentSince: at };
    case "fault":
      return { ...next, status: "faulted", current: e.step!, fault: { step: e.step!, reason: e.detail.reason ?? "Fault" } };
    case "retry":
      return { ...next, status: "running", fault: null };
    case "skip": {
      const skipped = new Set(v.skipped);
      skipped.add(e.step!);
      return { ...next, status: "running", fault: null, skipped, current: e.step! + 1 };
    }
    case "complete":
      return { ...next, status: "complete", finishedAt: at };
    default:
      return next;
  }
}

export function useRunStream(runId: string) {
  const [view, dispatch] = useReducer(reduce, initial);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // EventSource reconnects on its own and sends Last-Event-ID, so the server resumes where we left off.
    const es = new EventSource(`/api/runs/${runId}/stream`);
    es.onmessage = (m) => dispatch(JSON.parse(m.data));
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, [runId]);

  return { view, online };
}
