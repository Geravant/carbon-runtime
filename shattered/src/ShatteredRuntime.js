// Boot helpers for a host with its own content: what the Shattered Reach spike learned about
// starting the engine without EVE's scene driver, in one place.
import { blue } from "../../src/blue/index.js";
import { CjsBlueResFileSystemFetch } from "../../src/blue/io/CjsBlueResFileSystemFetch.js";
import { CjsLibrary } from "../../src/core/CjsLibrary.js";
import { TR2SHADERMODEL } from "../../src/global/consts/graphics/trinityEnums.js";
import { Tr2Blitter } from "../../src/trinity/core/Tr2Blitter.js";
import { Tr2Renderer } from "../../src/trinity/core/Tr2Renderer.js";
import { Tr2RenderContext_GetMainThreadRenderContext } from "../../src/trinity/core/context/Tr2RenderContext.js";
import { Tr2RenderJobs } from "../../src/trinity/renderJob/Tr2RenderJobs.js";
import { EffectKeyGenerator } from "../../src/trinity/core/batch/TriRenderBatch/EffectKeyGenerator.js";
import { SetTextureHost } from "./ShatteredTextures.js";

const SHADER_MODELS = Object.freeze({
  depth: TR2SHADERMODEL.TR2SM_3_0_DEPTH, hi: TR2SHADERMODEL.TR2SM_3_0_HI, lo: TR2SHADERMODEL.TR2SM_3_0_LO
});

/**
 * Names the host's own files for the two effects the engine itself creates (Tr2Blitter's
 * point-sampled and linear-sampled blit). Call before `ShatteredBoot` / `AttachTrinity`: the
 * renderer constructs its blitter when Trinity starts.
 *
 * @param {object} paths The paths, as authored `res:` effect paths (`res:/graphics/effect/<...>.fx`).
 * @param {string} [paths.blit] The point-sampled blit effect.
 * @param {string} [paths.blitFiltered] The linear-sampled blit effect.
 */
export function SetBuiltInEffectPaths({ blit, blitFiltered } = {})
{
  if (blit) Tr2Blitter.blitEffectPath = blit;
  if (blitFiltered) Tr2Blitter.blitFilteredEffectPath = blitFiltered;
}

let bootedDevice = null;
let singleJob = null;

/**
 * The canvas as a render target, the same call on WebGPU and WebGL2. Bind it with
 * `backend.al.SetRenderTarget(0, GetCanvasTarget(backend))` (and `backend.al.SetDepthStencil(null)`),
 * then set a viewport: `renderContext.GetEffectStateManager().SetViewport({ x, y, width, height })`
 * in canvas pixels with the origin at the top left, or `SetFullScreenViewport()` after an offscreen
 * target of the canvas's size was bound. `ShatteredBoot` also puts this on the backend it returns as
 * `backend.GetCanvasTarget()`.
 *
 * @param {object} backend The backend `ShatteredBoot` returned.
 * @returns {object} The canvas target for `SetRenderTarget`.
 */
export function GetCanvasTarget(backend)
{
  return backend.al.GetDefaultBackBuffer();
}

/**
 * Draws now: runs render jobs exactly once, inside one device frame, before returning.
 *
 * With a job, only that job runs (it need not be registered with the device, and its `enabled` flag
 * still applies). With no argument, every job installed on the device runs once, in order. Nothing
 * else happens: no resource loading is pumped, no Blue ticker runs, the animation clock does not move.
 * It may be called any number of times in one task, for example once per view drawn into its own
 * viewport of the canvas; each call is one complete frame for the device (its own command buffer).
 *
 * `blue.os.PumpOS()` also runs the device's jobs exactly once per call - PumpOS calls every ticker
 * once, the device's tick calls `Render` once, and nothing in between is gated on time - but it pumps
 * loading and presents as well. A host that draws several views a frame calls `PumpLoading()` once and
 * `DrawNow(job)` per view.
 *
 * @param {object} [job] A `TriRenderJob`; omitted, the device's installed jobs.
 * @returns {number|undefined} The job's status after the run (`TriRenderJob.Status`), when a job was given.
 */
export function DrawNow(job = null)
{
  const device = bootedDevice;
  if (!device) throw new Error("DrawNow needs ShatteredBoot to have run");
  if (!job)
  {
    device.Render();
    return undefined;
  }
  const installed = device.GetRenderJobs();
  singleJob ??= new Tr2RenderJobs();
  singleJob.recurring.Clear();
  singleJob.recurring.push(job);
  device.SetRenderJobs(singleJob);
  try
  {
    device.Render();
  }
  finally
  {
    device.SetRenderJobs(installed);
    singleJob.recurring.Clear();
  }
  return job.status;
}

/**
 * One Blue tick with no render job run: resources finish loading (`blue.resMan.Ready` resolves),
 * callbacks and curve sets run, a lost device is noticed and replaced, and nothing is drawn. The
 * canvas keeps its picture. Call it every animation frame while the host draws with `DrawNow`, and
 * while waiting on a load when the installed jobs must not run.
 *
 * (To silence one job instead, set its `enabled = false`: a disabled job is skipped by `PumpOS` and
 * by `DrawNow`.)
 */
export function PumpLoading()
{
  const device = bootedDevice;
  if (!device) throw new Error("PumpLoading needs ShatteredBoot to have run");
  const installed = device.GetRenderJobs();
  device.SetRenderJobs(null);
  try
  {
    blue.os.PumpOS();
  }
  finally
  {
    device.SetRenderJobs(installed);
  }
}

/**
 * Starts the engine on a canvas for a host that brings all of its own content: effects already
 * compiled for the backend (no DXBC translator), no ship assembly, character or audio services,
 * no callback workers.
 *
 * The effect tree follows the backend acquired: `effect.webgpu/` on WebGPU and `effect.webgl/`
 * on WebGL2, under the `res` root (scripts/build-effects.mjs writes both).
 *
 * Blue is host-pumped: resources only finish loading while something calls `blue.os.PumpOS()`,
 * and the same call runs the device's render jobs. The host owns that loop.
 *
 * @param {object} options Start-up options.
 * @param {HTMLCanvasElement} options.canvas The canvas to draw to, already sized in device pixels.
 * @param {string|URL} options.res Where `res:/` resolves, as a URL ending in `/`.
 * @param {string[]} [options.preference] Backends to try in order; default WebGPU then WebGL2.
 * @param {"depth"|"hi"|"lo"} [options.shaderModel="depth"] Which compiled suffix effects load (`.sm_depth`, ...).
 * @param {object} [options.effectPaths] `SetBuiltInEffectPaths` argument.
 * @param {"opaque"|"premultiplied"} [options.alphaMode="opaque"] Canvas compositing.
 * @param {object} [options.configuration] Further `CjsLibrary` configuration sections.
 * @returns {Promise<{library: CjsLibrary, backend: object, device: object, renderContext: object, effectTarget: string}>}
 */
export async function ShatteredBoot({ canvas, res, preference = [ "webgpu", "webgl2" ], shaderModel = "depth", effectPaths = null,
  alphaMode = "opaque", configuration = {} } = {})
{
  if (!Object.hasOwn(SHADER_MODELS, shaderModel)) throw new RangeError(`shaderModel must be one of ${Object.keys(SHADER_MODELS).join(", ")}`);
  if (effectPaths) SetBuiltInEffectPaths(effectPaths);
  // Effect-sorted accumulators (opaque, decal, additive) set aside every indexed triangle batch whose material
  // binds no texture as a "GPU-driven" batch (TriRenderBatchAccumulator.Commit), and nothing in this runtime
  // draws that list: TriStepRenderObject and Tr2RenderContext.RenderBatches walk only the plain one. An
  // untextured effect on an instanced quad (particles, markers) or a mesh was silently never drawn. With the
  // flag off every batch goes to the plain list, effect-sorted as before.
  EffectKeyGenerator.ALLOW_GDPR = false;

  const library = new CjsLibrary({ callbackMan: { useWorkers: false }, ...configuration });
  // translator: false - GetEffectConfiguration then names the backend's own effect tree.
  const backend = await library.AcquireBackend({ canvas, preference, alphaMode, shaderModel, translator: false });
  const resRoot = new URL(res, globalThis.location?.href).href;
  library.SetConfiguration({ paths: { host: new CjsBlueResFileSystemFetch({ paths: { res: resRoot } }) } });
  SetTextureHost(resRoot, backend);
  // Explicit nulls: with the keys absent, Initialize constructs EVE's SOF and character library.
  await library.Initialize({ sof: null, characterLibrary: null });
  const device = library.AttachTrinity({ renderContextAL: backend.al, backend: backend.name });
  Tr2Renderer.SetShaderModel(SHADER_MODELS[shaderModel]);
  device.width = canvas.width;
  device.height = canvas.height;
  bootedDevice = device;
  backend.GetCanvasTarget = () => GetCanvasTarget(backend);
  return {
    library, backend, device,
    renderContext: Tr2RenderContext_GetMainThreadRenderContext(),
    effectTarget: backend.name === "webgpu" ? "webgpu" : "webgl",
    blue
  };
}
