// Writes the licenses of everything bundled into the built web app (dist/web/THIRD_PARTY_LICENSES.txt).
// The server's dependencies ship as installed npm packages and carry their own license files.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
// Packages the web bundle imports directly; their runtime dependencies are followed.
const entry = ["react", "react-dom", "dompurify", "chrono-node", "@fontsource-variable/geist", "@fontsource-variable/geist-mono"];

function pkgDir(name, from = root) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(candidate);
    const up = dirname(dir);
    if (up === dir) throw new Error(`Can't find ${name}`);
    dir = up;
  }
}

const seen = new Map();
function visit(name, from) {
  const dir = pkgDir(name, from);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  seen.set(key, { license: typeof pkg.license === "string" ? pkg.license : "see text", text: file ? readFileSync(join(dir, file), "utf8").trim() : "" });
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir);
}
for (const name of entry) visit(name, root);

const body = [...seen]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, { license, text }]) => `${"=".repeat(72)}\n${key} (${license})\n${"=".repeat(72)}\n\n${text || "(license text not included in the package; see the package's repository)"}\n`)
  .join("\n");
const header =
  "Slipstream is licensed under the GNU Affero General Public License v3.0 (see LICENSE).\n" +
  "The web app bundles the following third-party software, under these licenses.\n" +
  "Where a package offers a choice of licenses, Slipstream uses it under the permissive option (MIT or Apache-2.0).\n\n";
writeFileSync(join(root, "dist", "web", "THIRD_PARTY_LICENSES.txt"), header + body);
console.log(`Wrote licenses for ${seen.size} bundled packages to dist/web/THIRD_PARTY_LICENSES.txt`);
