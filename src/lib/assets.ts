import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./root";

export const PUBLIC_DIR = join(ROOT, "public");

const versions = new Map<string, string>();

/** Cache-busting URL for a built asset; versions are computed once per process. */
export function asset(name: string): string {
  let version = versions.get(name);
  if (!version) {
    const file = join(PUBLIC_DIR, "assets", name);
    version = existsSync(file) ? Bun.hash(readFileSync(file)).toString(36) : "dev";
    if (process.env.NODE_ENV === "production") versions.set(name, version);
  }
  return `/assets/${name}?v=${version}`;
}
