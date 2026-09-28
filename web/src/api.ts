import { useQuery } from "@tanstack/react-query";
import type { Issue, PanelRow, Revision, Run, Spec, Step } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: Issue[],
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.issues, data);
  return data as T;
}

export const api = {
  panels: () => request<PanelRow[]>("GET", "/panels"),
  samples: () => request<{ key: string; spec: Spec }[]>("GET", "/samples"),
  createPanel: (spec: Spec) => request<{ panel_id: string; revision_id: string }>("POST", "/panels", { spec }),
  duplicate: (panelId: string) => request<{ revision_id: string }>("POST", `/panels/${panelId}/duplicate`),
  revision: (id: string) => request<Revision>("GET", `/revisions/${id}`),
  save: (id: string, spec: Spec, steps: Step[]) => request<{ ok: true }>("PUT", `/revisions/${id}`, { spec, steps }),
  release: (id: string) => request<{ ok: true }>("POST", `/revisions/${id}/release`),
  revise: (id: string) => request<{ revision_id: string }>("POST", `/revisions/${id}/revise`),
  startRun: (id: string, speed: number) => request<{ run_id: string }>("POST", `/revisions/${id}/runs`, { speed }),
  run: (id: string) => request<Run>("GET", `/runs/${id}`),
  act: (id: string, action: "retry" | "skip", reason?: string) =>
    request<{ ok: true }>("POST", `/runs/${id}/actions`, { action, reason }),
  reset: () => request<{ ok: true }>("POST", "/demo/reset"),
};

export const usePanels = () => useQuery({ queryKey: ["panels"], queryFn: api.panels });
export const useSamples = () => useQuery({ queryKey: ["samples"], queryFn: api.samples, staleTime: Infinity });
export const useRevision = (id: string) => useQuery({ queryKey: ["revision", id], queryFn: () => api.revision(id) });
export const useRun = (id: string) => useQuery({ queryKey: ["run", id], queryFn: () => api.run(id) });

export function errorText(e: unknown) {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
