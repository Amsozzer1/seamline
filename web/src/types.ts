export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type Stiffener = {
  id: string;
  profile?: string;
  height_mm: number;
  thickness_mm: number;
  start: Vec2;
  end: Vec2;
};

export type Spec = {
  name: string;
  plate: { length_mm: number; width_mm: number; thickness_mm: number };
  stiffeners: Stiffener[];
};

export type Issue = { severity: "error" | "warning"; code: string; message: string; part_id?: string };

export type Seam = {
  id: string;
  kind: "fillet" | "joint";
  group: string;
  side: string;
  parts: [string, string];
  start: Vec3;
  end: Vec3;
  length_mm: number;
};

export type Step = {
  kind: "tack" | "weld";
  seam_id: string;
  portion: "full" | "first_half" | "second_half";
  direction: "forward" | "reverse";
};

export type Plan = { issues: Issue[]; seams: Seam[]; steps: Step[] };

export type PanelRow = {
  id: string;
  name: string;
  locked: boolean;
  revision_id: string;
  rev: number;
  status: "draft" | "released";
  updated_at: string;
};

export type Revision = {
  id: string;
  rev: number;
  status: "draft" | "released";
  spec: Spec;
  steps: Step[];
  created_at: string;
  released_at: string | null;
  panel: { id: string; name: string; locked: boolean };
  revisions: { id: string; rev: number; status: string }[];
  runs: { id: string; status: string; created_at: string }[];
};

export type RunStatus = "running" | "faulted" | "complete" | "aborted";

export type Run = {
  id: string;
  status: RunStatus;
  current_step: number;
  speed: number;
  created_at: string;
  finished_at: string | null;
  revision_id: string;
  rev: number;
  spec: Spec;
  steps: Step[];
  panel_id: string;
  panel_name: string;
};

export type RunEvent = {
  id: number;
  run_id: string;
  kind: "started" | "step_started" | "step_done" | "fault" | "retry" | "skip" | "complete";
  step: number | null;
  detail: { reason?: string; seam_id?: string; speed?: number; scripted?: boolean };
  at: string;
};
