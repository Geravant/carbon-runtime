// Exports one Shattered Reach hull as plain data, by running the game's own hull builder.
//
//   node examples/shattered-spike/tools/export-hull.mjs [hullId] [--game <path>] [--ref <git ref>]
//
// The game checkout is never modified: its builder (src/ship-models.js) and hull data
// (src/content/hulls-3d.json) are read with `git show <ref>:<path>` into .game-src/ beside this
// script (gitignored), and imported from there with the three.js installed in this folder.
//
// Output, in ../data/:
//   <hull>.json  - what the mesh is: vertex layout, counts, bounds, parts (index range, pigment, kind)
//   <hull>.bin   - vertices (interleaved float32, the layout the JSON names), then indices (uint32)
//
// Vertex: position(3) normal(3) colour(3) kind(1) seam(2) = 12 floats, 48 bytes.
// kind: 0 hull, 1 light, 2 engine glow, 3 dark (the game's aKind). seam: style, lines per unit (aSeam).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) =>
{
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const game = resolve(option("--game", join(homedir(), "RiderProjects/shattered-reach")));
const ref = option("--ref", "origin/main");
const hullId = args[0] ?? "cruiser";

const show = path => execFileSync("git", [ "-C", game, "show", `${ref}:${path}` ], { maxBuffer: 64 * 1024 * 1024 });
const commit = execFileSync("git", [ "-C", game, "rev-parse", ref ]).toString().trim();

const staged = join(here, ".game-src", "src");
mkdirSync(join(staged, "content"), { recursive: true });
writeFileSync(join(staged, "ship-models.js"), show("src/ship-models.js"));
writeFileSync(join(staged, "content", "hulls-3d.json"), show("src/content/hulls-3d.json"));

const { buildHull, hasModel } = await import(pathToFileURL(join(staged, "ship-models.js")).href);
if (!hasModel(hullId)) throw new Error(`No hull "${hullId}" in hulls-3d.json`);

// The builder only stores the material on its meshes; it never reads it.
const hull = buildHull(hullId, { body: null }, 0);

const FLOATS = 12;
const vertices = [];
const indices = [];
const seen = new Map();
const parts = [];
const min = [ Infinity, Infinity, Infinity ], max = [ -Infinity, -Infinity, -Infinity ];

for (const mesh of hull.parts)
{
  const g = mesh.geometry, a = g.attributes;
  const first = indices.length;
  const tally = new Map();
  for (let i = 0; i < a.position.count; i++)
  {
    const v = [
      a.position.getX(i), a.position.getY(i), a.position.getZ(i),
      a.normal.getX(i), a.normal.getY(i), a.normal.getZ(i),
      a.aCol.getX(i), a.aCol.getY(i), a.aCol.getZ(i),
      a.aKind.getX(i),
      a.aSeam.getX(i), a.aSeam.getY(i)
    ].map(Math.fround);
    const key = v.join(",");
    let index = seen.get(key);
    if (index === undefined)
    {
      index = vertices.length / FLOATS;
      seen.set(key, index);
      vertices.push(...v);
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], v[axis]); max[axis] = Math.max(max[axis], v[axis]); }
    }
    indices.push(index);
    const colourKey = `${v[9]}|${v[6]},${v[7]},${v[8]}`;
    tally.set(colourKey, (tally.get(colourKey) ?? 0) + 1);
  }
  const [ dominant ] = [ ...tally.entries() ].sort((x, y) => y[1] - x[1])[0];
  const [ kind, colour ] = dominant.split("|");
  parts.push({
    firstIndex: first, indexCount: indices.length - first,
    kind: Number(kind), colour: colour.split(",").map(Number),
    centre: mesh.userData.home.toArray().map(Math.fround)
  });
}

const vertexBytes = new Float32Array(vertices);
const indexBytes = new Uint32Array(indices);
const out = join(here, "..", "data");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${hullId}.bin`), Buffer.concat([ Buffer.from(vertexBytes.buffer), Buffer.from(indexBytes.buffer) ]));
writeFileSync(join(out, `${hullId}.json`), `${JSON.stringify({
  hull: hullId,
  source: { repository: "shattered-reach", ref, commit, builder: "src/ship-models.js buildHull", data: "src/content/hulls-3d.json" },
  axes: "+x nose, +y dorsal, +z starboard; centred on the bounding box",
  vertex: {
    stride: FLOATS * 4,
    elements: [
      { name: "position", floats: 3, offset: 0 },
      { name: "normal", floats: 3, offset: 12 },
      { name: "colour", floats: 3, offset: 24 },
      { name: "kind", floats: 1, offset: 36 },
      { name: "seam", floats: 2, offset: 40 }
    ]
  },
  vertexCount: vertexBytes.length / FLOATS,
  indexCount: indexBytes.length,
  indexFormat: "uint32",
  vertexByteOffset: 0,
  indexByteOffset: vertexBytes.byteLength,
  bounds: { min, max },
  length: hull.length,
  radius: hull.radius,
  exhausts: hull.exhausts,
  parts
}, null, 1)}\n`);

console.log(`${hullId}: ${vertexBytes.length / FLOATS} vertices, ${indexBytes.length / 3} triangles, ${parts.length} parts, `
  + `${vertexBytes.byteLength + indexBytes.byteLength} bytes (game ${commit.slice(0, 9)})`);
