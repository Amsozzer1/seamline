import init, { check as wasmCheck, plan as wasmPlan } from "seamcore";
import type { Issue, Plan, Seam, Step } from "./types";

// The same Rust core the server uses, compiled for the browser.
export const ready = init();

export function planFromText(specText: string): Plan {
  return JSON.parse(wasmPlan(specText));
}

export function plan(spec: unknown): Plan {
  return planFromText(JSON.stringify(spec));
}

export function check(spec: unknown, steps: Step[]): Issue[] {
  return JSON.parse(wasmCheck(JSON.stringify(spec), JSON.stringify(steps))).issues;
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");

// Mirrors the simulated cell's timing (server/src/cell.ts) so the torch animation matches.
export function stepDurationMs(step: Step, seam: Seam | undefined, speed: number) {
  if (step.kind === "tack" || !seam) return 400 / speed;
  const len = step.portion === "full" ? seam.length_mm : seam.length_mm / 2;
  return Math.max(600, len * 0.5) / speed;
}

export function portionLabel(step: Step) {
  if (step.kind === "tack") return "tack";
  if (step.portion === "first_half") return "weld, first half";
  if (step.portion === "second_half") return "weld, second half";
  return "weld";
}
