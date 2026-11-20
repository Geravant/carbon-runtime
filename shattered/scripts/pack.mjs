// Builds the slim runtime and packs it as an npm tarball a game can depend on, pinned to this commit.
//
//   node shattered/scripts/pack.mjs [--allow-dirty]
//
// Writes shattered/pack/geravant-carbon-runtime-slim-<version>.tgz, where <version> is the engine's
// version with `.sr.g<commit>` appended, and prints its path. The package has no dependencies: gl-matrix,
// yaml and meshoptimizer are bundled in, with their licences under licenses/.
// Refuses a working tree with uncommitted changes to tracked files unless --allow-dirty (the version
// then ends in `.dirty`), because the commit in the name is the only record of what was built.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shattered = path.resolve(here, "..");
const root = path.resolve(shattered, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
if (dirty && !process.argv.includes("--allow-dirty"))
{
  console.error("pack: tracked files have uncommitted changes; commit first, or pass --allow-dirty");
  process.exit(1);
}
const commit = git("rev-parse", "HEAD");
let upstream = null;
try { upstream = git("merge-base", "HEAD", "upstream/main"); } catch { /* no upstream remote here */ }

execFileSync(process.execPath, [ path.join(here, "build-slim.mjs") ], { cwd: root, stdio: "inherit" });

const source = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = `${source.version}.sr.g${commit.slice(0, 9)}${dirty ? ".dirty" : ""}`;
const stage = path.join(shattered, "pack", "package");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(shattered, "dist"), path.join(stage, "dist"), { recursive: true, filter: file => !file.endsWith("meta.json") });
for (const name of [ "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md" ]) fs.copyFileSync(path.join(root, name), path.join(stage, name));
fs.copyFileSync(path.join(root, "docs", "shattered", "consuming.md"), path.join(stage, "README.md"));
for (const name of Object.keys(source.dependencies ?? {}))
{
  const directory = path.join(root, "node_modules", name);
  const licence = fs.readdirSync(directory).find(file => /^licen[cs]e/iu.test(file));
  if (!licence) throw new Error(`dependency ${name} ships no licence file`);
  fs.mkdirSync(path.join(stage, "licenses"), { recursive: true });
  fs.copyFileSync(path.join(directory, licence), path.join(stage, "licenses", `${name}-${licence}`));
}
const sizes = JSON.parse(fs.readFileSync(path.join(shattered, "dist", "sizes.json"), "utf8"));
fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({
  name: "@geravant/carbon-runtime-slim",
  version,
  description: "Slim composition of the CarbonEngineJS runtime for Shattered Reach: device layers, Trinity core, render jobs, effect loader, geometry intake, input. No EVE scene classes, SOF, character or audio.",
  type: "module",
  license: source.license,
  sideEffects: true,
  exports: { ".": "./dist/index.js", "./fx": "./dist/tools/build-effects.mjs", "./package.json": "./package.json" },
  bin: { "carbon-fx": "./dist/tools/build-effects.mjs" },
  files: [ "dist", "licenses", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md", "README.md" ],
  engines: source.engines,
  repository: { type: "git", url: "git+https://github.com/Geravant/carbon-runtime.git" },
  carbon: { commit, branch: git("rev-parse", "--abbrev-ref", "HEAD"), upstreamBase: upstream, dirty, minifiedAlwaysLoaded: sizes.always }
}, null, 2)}\n`);

const out = path.join(shattered, "pack");
const packed = JSON.parse(execFileSync("npm", [ "pack", "--json", "--pack-destination", out ], { cwd: stage, encoding: "utf8" }));
const tarball = path.join(out, packed[0].filename);
fs.writeFileSync(path.join(out, "latest.json"), `${JSON.stringify({ tarball, filename: packed[0].filename, version, commit, dirty, bytes: fs.statSync(tarball).size, integrity: packed[0].integrity }, null, 1)}\n`);
console.log(`packed ${tarball} (${(fs.statSync(tarball).size / 1024).toFixed(0)} KB)`);
