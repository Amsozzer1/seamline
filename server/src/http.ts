import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Issue } from "./core.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: Issue[],
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const conflict = (message: string, extra?: Record<string, unknown>) => new HttpError(409, message, undefined, extra);
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const invalid = (message: string, issues?: Issue[]) => new HttpError(422, message, issues);

const uuid = z.uuid();

/** Validate a route id before it reaches Postgres (a malformed uuid there is a 500). */
export function id(req: Request, name = "id"): string {
  const v = req.params[name];
  if (!uuid.safeParse(v).success) throw notFound("Resource");
  return v as string;
}

export function body<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.body);
  if (!r.success) throw invalid(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, issues: err.issues, ...err.extra });
    return;
  }
  // Postgres unique violation: a concurrent request won the race for the same state change.
  if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
    res.status(409).json({ error: "That change conflicts with another one that just happened. Reload and try again." });
    return;
  }
  if (typeof err === "object" && err && (err as { type?: string }).type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal error" });
}
