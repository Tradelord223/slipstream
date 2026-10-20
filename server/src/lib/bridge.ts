import { realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import type { Cli } from "../../../web/src/lib/connect.ts";
import { packageVersion } from "./version.ts";

/** What the lookups read, so tests can stand in for the machine. */
interface Where {
  path?: string;
  realpath?: (p: string) => string;
  version?: string;
}

/** A PATH entry named `node` that is this very node, e.g. /opt/homebrew/bin/node rather than a versioned Cellar path that the next upgrade deletes. */
export function stableNode(execPath: string, path: string, realpath: (p: string) => string): string {
  try {
    const self = realpath(execPath);
    for (const dir of path.split(delimiter).filter(isAbsolute)) {
      const candidate = join(dir, "node");
      try {
        if (realpath(candidate) === self) return candidate;
      } catch {
        // not there
      }
    }
  } catch {
    // execPath itself can't be resolved; use it as it is
  }
  return execPath;
}

/**
 * How an assistant starts the stdio bridge: this very program by absolute path, as Settings → Connect shows it,
 * since the assistant doesn't share your shell's PATH. Run through npx, that path is in a cache npm clears, so
 * the assistant gets npx's own script, run by node, pinned to this version so the bridge matches the running server.
 * `slipstream connect` and Settings → Connect both build it here, so they can't drift.
 */
export function bridgeCli(entry: string, execPath = process.execPath, where: Where = {}): NonNullable<Cli> {
  const realpath = where.realpath ?? realpathSync;
  const node = stableNode(execPath, where.path ?? process.env.PATH ?? "", realpath);
  if (!entry.includes(`${sep}_npx${sep}`)) return { command: node, args: [entry] };
  const version = where.version ?? packageVersion();
  const pkg = version === "unknown" ? "slipstream-mail" : `slipstream-mail@${version}`;
  try {
    // On Homebrew, nvm and the official installers `npx` is a link to npm's npx-cli.js, which node can run directly.
    const script = realpath(join(dirname(node), "npx"));
    if (/\.[cm]?js$/.test(script)) return { command: node, args: [script, "-y", pkg] };
  } catch {
    // no npx beside this node
  }
  return { command: "npx", args: ["-y", pkg] };
}
