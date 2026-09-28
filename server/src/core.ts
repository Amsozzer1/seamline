import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The Node build of seamcore is CommonJS; load it from ESM with createRequire.
// Same path from src/ (tsx) and dist/ (compiled), both one level under server/.
const require = createRequire(import.meta.url);
const wasm = require(fileURLToPath(new URL("../../seamcore/pkg-node/seamcore.js", import.meta.url))) as {
  plan(spec: string): string;
  check(spec: string, steps: string): string;
};

export type Issue = { severity: "error" | "warning"; code: string; message: string; part_id?: string };
export type Seam = {
  id: string;
  kind: "fillet" | "joint";
  group: string;
  side: string;
  parts: [string, string];
  start: [number, number, number];
  end: [number, number, number];
  length_mm: number;
};
export type Step = {
  kind: "tack" | "weld";
  seam_id: string;
  portion: "full" | "first_half" | "second_half";
  direction: "forward" | "reverse";
};
export type Plan = { issues: Issue[]; seams: Seam[]; steps: Step[] };

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");

export function plan(spec: unknown): Plan {
  return JSON.parse(wasm.plan(JSON.stringify(spec)));
}

export function check(spec: unknown, steps: unknown): Issue[] {
  return JSON.parse(wasm.check(JSON.stringify(spec), JSON.stringify(steps))).issues;
}
