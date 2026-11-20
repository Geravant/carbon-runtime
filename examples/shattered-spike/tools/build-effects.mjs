// Compiles the spike's own effects (../effects/**/*.fx) for WebGPU and WebGL2 with the fork's
// effect build (shattered/scripts/build-effects.mjs):
//
//   node examples/shattered-spike/tools/build-effects.mjs
//
// `effects/<path>.fx` becomes `res/graphics/effect.{webgpu,webgl}/shattered/<path>.sm_*`; the page
// names it `res:/graphics/effect/shattered/<path>.fx`. `effects/system/` holds our own blit effects,
// which the page hands to the engine by path (SetBuiltInEffectPaths).
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildEffects } from "../../../shattered/scripts/build-effects.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "res", "graphics"), { recursive: true, force: true });
const result = BuildEffects({ src: join(root, "effects"), out: join(root, "res"), prefix: "shattered", log: line => console.log(line) });
console.log(`${result.written.length} containers written, ${result.failed.length} failed`);
if (result.failed.length) process.exit(1);
