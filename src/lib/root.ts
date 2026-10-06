import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Project root, whether running from src/ or the bundled dist/server.js. */
export const ROOT = (() => {
  let dir = import.meta.dir;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
  return dir;
})();
