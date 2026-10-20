import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed version, from the nearest package.json (dist/ in a build, server/src/ in the repo). */
export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "slipstream-mail") return pkg.version ?? "unknown";
    }
    dir = dirname(dir);
  }
  return "unknown";
}
