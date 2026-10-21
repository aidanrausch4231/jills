import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write a file atomically: write a temp file in the same folder, then rename it. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export const writeJsonAtomic = (path: string, value: unknown) => writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Parse "90", "90s", "5m", "2h", or a number of seconds into milliseconds. */
export function parseDuration(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v > 0 ? v * 1000 : undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(String(v));
  if (!m) throw new Error(`bad duration: ${String(v)} (use e.g. 30s, 10m, 1h)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "s"];
}

/** Largest delay setTimeout accepts (2^31-1 ms); larger values fire at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A time limit in ms: parseDuration(v) clamped to MAX_TIMER_MS; undefined when unset or <= 0. */
export function parseLimit(v: unknown): number | undefined {
  const ms = parseDuration(v);
  return ms && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : undefined;
}

export function newId(): string {
  const iso = new Date().toISOString(); // 2026-10-07T12:34:56.789Z
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fn(0..count-1) with at most `limit` running at once; results in order. */
export async function pool<T>(count: number, limit: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, count) }, async () => { while (next < count) { const i = next++; out[i] = await fn(i); } }));
  return out;
}

