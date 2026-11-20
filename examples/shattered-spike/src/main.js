// Shattered Reach rendering spike: one of our own hulls drawn by the CarbonEngineJS
// runtime's real draw path (render job -> render steps -> batches -> Tr2RenderContext
// -> the WebGPU abstraction layer), with our own effects and our own full-screen
// watercolour pass. No EVE content: the hull is data exported from the game, the
// effects are ours (../effects/*.fx), and nothing else is loaded.
//
// URL parameters:
//   ships=N      how many ships to draw (default 1; 30 for the fleet measurement)
//   yaw=DEG      hold the camera at this yaw instead of orbiting
//   elevation=DEG camera elevation above the ship's plane (default 12, the game's battle view)
//   paint=0      skip the watercolour pass: the hull's colour target blitted as it is
//   bench=N      measure N frames and put the result in window.__spike.bench
//   backend=webgl2  ask for the WebGL2 backend only (default: WebGPU, then WebGL2)
import {
  blue, BlueScriptCallback, mat4, vec3, DepthStencilFormat, PixelFormat, ShaderType, TriBatchType,
  Tr2Renderer, PER_FRAME_VS, PER_FRAME_PS, Tr2RenderUtils, Tr2RenderTarget, Tr2DepthStencil, Tr2Mesh, Tr2MeshArea,
  ITr2Renderable, TriView, TriProjection, RawData, CjsConstantLayout, TriGeometryRes, Tr2Effect, Tr2EffectStateManager,
  Tr2RenderJobs, TriRenderJob, TriStepClear, TriStepPythonCB, TriStepRenderEffect, TriStepRenderObject,
  TriStepSetProjection, TriStepSetView, Tr2ConstantBufferAL, ShatteredBoot
} from "@geravant/carbon-runtime-slim";

const T0 = performance.now();
const params = new URLSearchParams(location.search);
const SHIPS = Math.max(1, Number(params.get("ships") ?? 1) | 0);
const HELD_YAW = params.has("yaw") ? Number(params.get("yaw")) * Math.PI / 180 : null;
const ELEVATION = Number(params.get("elevation") ?? 12) * Math.PI / 180;
const PAINT = params.get("paint") !== "0";
const BENCH = Number(params.get("bench") ?? 0) | 0;
const HULL = params.get("hull") ?? "cruiser";
// camera=ortho (default, the game's own projection), perspective (an orbit in perspective) or flyby.
const CAMERA = params.get("camera") ?? "ortho";
// hold=1: time only moves through window.__spike.setTime, for frame sequences.
const HOLD = params.get("hold") === "1";
const BACKEND = params.get("backend");

const spike = window.__spike = { ready: false, error: null, frames: 0, firstFrameMs: null, bench: null, diagnostics: [] };

// ---------------------------------------------------------------------------------------------
// Our own constant layouts, matching ../effects/ShatteredFrame.fxh, registered beside the
// engine's catalogs so RawData.create finds them by struct name.
const { Types, Identity } = CjsConstantLayout;
RawData.RegisterLayouts({
  ShatteredPerFrame: {
    vs: { struct: "ShatteredPerFrameVSData", fields: {
      ViewProjectionMat: { type: Types.MATRIX4, default: Identity },
      ViewMat: { type: Types.MATRIX4, default: Identity }
    } },
    ps: { struct: "ShatteredPerFramePSData", fields: {
      LightDirection: { type: Types.VECTOR4 },
      Paper: { type: Types.VECTOR4 },
      Paint: { type: Types.VECTOR4 }
    } }
  },
  ShatteredObject: {
    vs: { struct: "ShatteredObjectVSData", fields: {
      worldTransform: { type: Types.MATRIX4, default: Identity }
    } }
  }
}, "ShatteredLayouts");

// ---------------------------------------------------------------------------------------------
// The hull as an engine geometry resource, from plain data. The only geometry format the engine
// routes is GR2; CMF is declared but unrouted. TriGeometryRes takes decoded CMF-shaped data
// though, through PrepareFromCmfData (the fork's public entry).
async function LoadHullGeometry(name)
{
  const [ meta, bytes ] = await Promise.all([
    fetch(`./data/${name}.json`).then(response => response.json()),
    fetch(`./data/${name}.bin`).then(response => response.arrayBuffer())
  ]);
  const floatsPerVertex = meta.vertex.stride / 4;
  const interleaved = new Float32Array(bytes, meta.vertexByteOffset, meta.vertexCount * floatsPerVertex);
  const indices = new Uint32Array(bytes, meta.indexByteOffset, meta.indexCount);

  const channel = (offset, count) =>
  {
    const out = new Float32Array(meta.vertexCount * count);
    for (let v = 0; v < meta.vertexCount; v++)
      for (let c = 0; c < count; c++) out[v * count + c] = interleaved[v * floatsPerVertex + offset + c];
    return out;
  };

  const payload = {
    meshes: [ {
      name: meta.hull,
      decl: [
        { usage: "Position", usageIndex: 0, type: "Float32", elementCount: 3, offset: 0 },
        { usage: "Normal", usageIndex: 0, type: "Float32", elementCount: 3, offset: 12 },
        { usage: "Color", usageIndex: 0, type: "Float32", elementCount: 3, offset: 24 },
        { usage: "TexCoord", usageIndex: 0, type: "Float32", elementCount: 1, offset: 36 },
        { usage: "TexCoord", usageIndex: 1, type: "Float32", elementCount: 2, offset: 40 }
      ],
      vertex: {
        position: channel(0, 3), normal: channel(3, 3), color0: channel(6, 3),
        texcoord0: channel(9, 1), texcoord1: channel(10, 2)
      },
      vertexCount: meta.vertexCount,
      indexBuffer: indices,
      areas: [ { name: "hull", firstElement: 0, elementCount: meta.indexCount / 3 } ],
      bounds: meta.bounds,
      boundingSphere: [ 0, 0, 0, meta.radius ]
    } ]
  };

  const geometry = new TriGeometryRes();
  if (!geometry.PrepareFromCmfData(payload)) throw new Error("the hull geometry was refused");
  return { geometry, meta };
}

// ---------------------------------------------------------------------------------------------
// One ship: a transform and its own per-object constants over the shared mesh.
class ShatteredShip
{
  transform = mat4.create();
  home = vec3.create();
  phase = 0;
  objectData = { vs: RawData.create("ShatteredObjectVSData") };

  Update(time)
  {
    mat4.fromTranslation(this.transform, this.home);
    // A slow roll and bob, so thirty ships are not thirty copies of one pose.
    mat4.rotateY(this.transform, this.transform, this.phase);
    mat4.rotateX(this.transform, this.transform, Math.sin(time * 0.7 + this.phase) * 0.12);
    this.objectData.vs.SetAndTranspose("worldTransform", this.transform);
  }
}

// The fleet as one Trinity renderable: the render step asks it for batches, and it commits one
// batch a ship through the mesh's own batch builder (Tr2MeshBase.GetBatches).
class ShatteredFleet extends ITr2Renderable
{
  mesh = null;
  ships = [];

  GetPerObjectData(_accumulator)
  {
    return null;
  }

  GetBatches(accumulator, batchType, _perObjectData, _reason)
  {
    if (batchType !== TriBatchType.TRIBATCHTYPE_OPAQUE) return false;
    let committed = false;
    for (const ship of this.ships) committed = this.mesh.GetBatches(accumulator, batchType, ship.objectData) || committed;
    return committed;
  }

  HasTransparentBatches()
  {
    return false;
  }

  GetSortValue()
  {
    return 0;
  }
}

async function LoadEffect(name)
{
  const effect = new Tr2Effect();
  effect.effectFilePath = `res:/graphics/effect/shattered/${name}.fx`;
  effect.Initialize();
  await blue.resMan.Ready(effect.effectResource);
  effect.RebuildCachedData();
  Tr2EffectStateManager.registerShaderHandles(effect.shader);
  if (!effect.IsGood()) throw new Error(`effect ${name} is not good after load`);
  return effect;
}

async function Main()
{
  const canvas = document.getElementById("view");
  const ratio = Number(params.get("ratio") ?? globalThis.devicePixelRatio ?? 1);
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));

  // Our own effect trees are already compiled for each backend, so no translator; the two effects
  // the engine itself creates (the blitter's) are named as our own files.
  const { backend, device, renderContext, effectTarget } = await ShatteredBoot({
    canvas,
    res: new URL("./res/", location.href),
    preference: BACKEND ? [ BACKEND ] : [ "webgpu", "webgl2" ],
    effectPaths: { blit: "res:/graphics/effect/shattered/system/blit.fx", blitFiltered: "res:/graphics/effect/shattered/system/blitfiltered.fx" }
  });
  spike.backendName = backend.name;
  spike.effectTarget = effectTarget;
  if (backend.name === "webgpu")
    spike.adapter = await navigator.gpu.requestAdapter().then(a => a?.info ? `${a.info.vendor} ${a.info.architecture} ${a.info.device} ${a.info.description}`.trim() : "unknown");
  else
  {
    const gl = canvas.getContext("webgl2");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    spike.adapter = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  }
  // The canvas as a render target: WebGPU's is the backend's own, WebGL2's is the layer's default back buffer.
  const canvasTarget = () => (backend.name === "webgpu" ? backend.renderTarget : backend.al.GetDefaultBackBuffer());


  // Blue is host-pumped: resources only finish loading while something calls PumpOS.
  let loading = true;
  const pump = () => { if (!loading) return; blue.os.PumpOS(); requestAnimationFrame(pump); };
  requestAnimationFrame(pump);

  const [ { geometry, meta }, hullEffect, normalEffect, paintEffect ] = await Promise.all([
    LoadHullGeometry(HULL), LoadEffect("hull"), LoadEffect("hullnormal"), LoadEffect("watercolour")
  ]);

  const mesh = new Tr2Mesh();
  mesh.name = meta.hull;
  mesh.PySetGeometryRes(geometry);
  const area = new Tr2MeshArea();
  area.name = "hull";
  area.SetMaterial(hullEffect);
  area.SetIndex(0);
  area.SetCount(1);
  mesh.AddArea(TriBatchType.TRIBATCHTYPE_OPAQUE, area);

  const fleet = new ShatteredFleet();
  fleet.mesh = mesh;
  const columns = Math.ceil(Math.sqrt(SHIPS * 1.6));
  const rows = Math.ceil(SHIPS / columns);
  const spacingX = meta.length * 1.25, spacingZ = meta.length * 0.8;
  for (let i = 0; i < SHIPS; i++)
  {
    const ship = new ShatteredShip();
    const column = i % columns, row = Math.floor(i / columns);
    const inRow = Math.min(columns, SHIPS - row * columns);
    vec3.set(ship.home, (column - (inRow - 1) / 2) * spacingX, 0, (row - (rows - 1) / 2) * spacingZ);
    ship.phase = SHIPS === 1 ? 0 : i * 0.9;
    fleet.ships.push(ship);
  }
  const extent = SHIPS === 1 ? meta.radius * 1.15 : columns * spacingX * 0.5 + meta.radius * 0.2;

  // The scene's targets: colour (rgb the wash, a the hull's coverage), normal (rgb view normal,
  // a depth) and a depth buffer, all the canvas's size.
  const colourTarget = new Tr2RenderTarget();
  const normalTarget = new Tr2RenderTarget();
  const depth = new Tr2DepthStencil();
  const CreateTargets = () =>
  {
    colourTarget.Create(canvas.width, canvas.height, 1, PixelFormat.PIXEL_FORMAT_R16G16B16A16_FLOAT);
    normalTarget.Create(canvas.width, canvas.height, 1, PixelFormat.PIXEL_FORMAT_R16G16B16A16_FLOAT);
    depth.Create(canvas.width, canvas.height, DepthStencilFormat.DSFMT_D32F, 1, 0, 0, renderContext);
    if (!colourTarget.IsValid() || !normalTarget.IsValid() || !depth.IsValid()) throw new Error(`the scene targets could not be created (colour ${colourTarget.IsValid()}, normal ${normalTarget.IsValid()}, depth ${depth.IsValid()})`);
  };
  CreateTargets();

  const view = new TriView();
  const projection = new TriProjection();
  const frameVS = RawData.create("ShatteredPerFrameVSData");
  const framePS = RawData.create("ShatteredPerFramePSData");
  const frameVSBuffer = new Tr2ConstantBufferAL();
  const framePSBuffer = new Tr2ConstantBufferAL();
  const viewProjection = mat4.create();
  const viewMatrix = mat4.create();
  const eye = vec3.create();
  const state = { time: 0, yaw: HELD_YAW ?? 0 };

  const esm = () => renderContext.GetEffectStateManager();
  const callback = fn =>
  {
    const step = new TriStepPythonCB();
    step.callback = BlueScriptCallback.from(fn);
    return step;
  };
  const clear = () =>
  {
    const step = new TriStepClear();
    step.color.set([ 0, 0, 0, 0 ]);
    step.depth = 1;
    step.isColorCleared = true;
    step.isDepthCleared = true;
    return step;
  };
  const renderFleet = override =>
  {
    const step = new TriStepRenderObject();
    step.renderable = fleet;
    step.effectOverride = override;
    step.renderDecal = step.renderTransparent = step.renderAdditive = false;
    return step;
  };
  const setView = new TriStepSetView();
  setView.view = view;
  const setProjection = new TriStepSetProjection();
  setProjection.projection = projection;
  const paint = new TriStepRenderEffect();
  paint.effect = paintEffect;

  const job = new TriRenderJob();
  job.name = "ShatteredSpike";
  for (const step of [
    // Update: the camera, the ships.
    callback(() =>
    {
      const aspect = canvas.width / canvas.height;
      const height = extent * 2 / aspect;
      const distance = extent * 4;
      if (CAMERA === "flyby")
      {
        // A fly-past in perspective: the camera travels a straight line beside the ship, looking at it.
        const along = (state.time % 8) / 8 * 2 - 1;
        vec3.set(eye, along * extent * 3.2, extent * 0.45, extent * 1.5);
        view.SetLookAtPosition(eye, [ 0, 0, 0 ], [ 0, 1, 0 ]);
        projection.PerspectiveFov(0.7, aspect, 0.1, extent * 12);
      }
      else
      {
        vec3.set(eye, Math.sin(state.yaw) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.cos(state.yaw) * Math.cos(ELEVATION));
        vec3.scale(eye, eye, distance);
        view.SetLookAtPosition(eye, [ 0, 0, 0 ], [ 0, 1, 0 ]);
        if (CAMERA === "perspective") projection.PerspectiveFov(0.55, aspect, 0.1, distance * 3);
        else projection.PerspectiveOrthographic(height * aspect, height, 0.1, distance * 2);
      }
      for (const ship of fleet.ships) ship.Update(state.time);
    }),
    // Pass 1: the body wash into the colour target.
    callback(() =>
    {
      esm().SetRenderTarget(0, colourTarget.GetRenderTarget());
      esm().SetDepthStencilBuffer(depth.GetDepthStencil());
      esm().SetFullScreenViewport();
    }),
    clear(),
    setView,
    setProjection,
    // Our per-frame constants, from the view and projection the two steps above set on the renderer.
    callback(() =>
    {
      mat4.copy(viewMatrix, Tr2Renderer.GetViewTransform());
      mat4.multiply(viewProjection, Tr2Renderer.GetProjectionTransform(), viewMatrix);
      frameVS.SetAndTranspose("ViewProjectionMat", viewProjection);
      frameVS.SetAndTranspose("ViewMat", viewMatrix);
      const light = vec3.normalize(vec3.create(), [ -0.45, 0.7, 0.55 ]);
      framePS.Set("LightDirection", [ light[0], light[1], light[2], 0 ]);
      framePS.Set("Paper", [ 0.958, 0.938, 0.897, 1 ]);
      framePS.Set("Paint", [ 0.85, 1, state.time, 0 ]);
      const vs = frameVS.GetData(), ps = framePS.GetData();
      Tr2RenderUtils.fillAndSetConstants(frameVSBuffer, vs, vs.byteLength, 1 << ShaderType.VERTEX_SHADER, PER_FRAME_VS, renderContext);
      Tr2RenderUtils.fillAndSetConstants(framePSBuffer, ps, ps.byteLength, 1 << ShaderType.PIXEL_SHADER, PER_FRAME_PS, renderContext);
    }),
    renderFleet(null),
    // Pass 2: normals and depth, the same batches under an override material.
    callback(() =>
    {
      esm().SetRenderTarget(0, normalTarget.GetRenderTarget());
      esm().SetDepthStencilBuffer(depth.GetDepthStencil());
      esm().SetFullScreenViewport();
    }),
    clear(),
    renderFleet(normalEffect),
    // Pass 3: the watercolour pass over both, onto the canvas.
    callback(() =>
    {
      backend.al.SetRenderTarget(0, canvasTarget());
      backend.al.SetDepthStencil(null);
      esm().SetFullScreenViewport();
      paintEffect.SetParameter__TextureAL("SceneColour", colourTarget.GetRenderTarget());
      paintEffect.SetParameter__TextureAL("SceneNormal", normalTarget.GetRenderTarget());
    }),
    paint
  ]) job.steps.push(step);

  const jobs = device.GetRenderJobs() ?? new Tr2RenderJobs();
  jobs.recurring.push(job);
  device.SetRenderJobs(jobs);

  loading = false;
  // The frame loop: Blue's tick runs Trinity, which runs the device's render jobs.
  const frameTimes = [];
  const gpuDevice = backend.webgpu?.GetDevice() ?? null;
  const gl = gpuDevice ? null : canvas.getContext("webgl2");
  // A canvas read asked for through spike.readCanvas, done inside the frame that drew it.
  let pendingRead = null;
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  let last = performance.now();
  const tick = now =>
  {
    requestAnimationFrame(tick);
    const dt = (now - last) / 1000;
    last = now;
    if (!HOLD)
    {
      state.time += dt;
      if (HELD_YAW === null) state.yaw += dt * 0.5;
    }
    const before = performance.now();
    blue.os.PumpOS();
    const cpu = performance.now() - before;
    spike.frames++;
    if (spike.firstFrameMs === null) spike.firstFrameMs = performance.now() - T0;
    // The frame's whole cost, CPU and GPU: from before the tick until the GPU reports the submitted work done.
    if (BENCH && !spike.bench && frameTimes.length < BENCH && spike.frames > 20)
    {
      const index = frameTimes.length;
      if (gpuDevice) gpuDevice.queue.onSubmittedWorkDone().then(() => { if (frameTimes[index]) frameTimes[index].done = performance.now() - before; });
      else { gl.finish(); queueMicrotask(() => { if (frameTimes[index]) frameTimes[index].done = performance.now() - before; }); }
    }
    if (pendingRead)
    {
      // Copy the canvas while this frame's picture is still in it, and say what is there.
      const resolve = pendingRead;
      pendingRead = null;
      probe.canvas.width = canvas.width;
      probe.canvas.height = canvas.height;
      probe.drawImage(canvas, 0, 0);
      const data = probe.getImageData(0, 0, canvas.width, canvas.height).data;
      const colours = new Set();
      let dark = 0, sum = 0;
      for (let i = 0; i < data.length; i += 4 * 7)
      {
        colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        const luma = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10;
        sum += luma;
        if (luma < 150) dark++;
      }
      const samples = Math.ceil(data.length / 28);
      const at = (x, y) => { const o = (Math.floor(y * canvas.height) * canvas.width + Math.floor(x * canvas.width)) * 4; return [ data[o], data[o + 1], data[o + 2], data[o + 3] ]; };
      resolve({ width: canvas.width, height: canvas.height, distinctColours: colours.size, meanLuma: +(sum / samples).toFixed(2), darkShare: +(dark / samples).toFixed(4), corner: at(0.02, 0.02), centre: at(0.5, 0.5) });
    }
    if (BENCH && spike.frames > 20 && !spike.bench)
    {
      frameTimes.push({ interval: dt * 1000, cpu });
      if (frameTimes.length >= BENCH) setTimeout(() =>
      {
        const sorted = key => frameTimes.map(entry => entry[key]).filter(value => value !== undefined).sort((a, b) => a - b);
        const summary = key =>
        {
          const values = sorted(key);
          return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, median: values[values.length >> 1], p95: values[Math.floor(values.length * 0.95)] };
        };
        spike.bench ??= { adapter: spike.adapter, ships: SHIPS, frames: frameTimes.length, width: canvas.width, height: canvas.height, interval: summary("interval"), cpu: summary("cpu"), submitToDone: summary("done") };
      }, 200);
    }
    const diagnostics = renderContext.GetDiagnostics();
    if (diagnostics.length)
    {
      for (const d of diagnostics) if (spike.diagnostics.length < 20) spike.diagnostics.push(`${d.type}: ${d.error?.stack ?? d.error ?? d.message ?? ""} ${d.step?.constructor?.name ?? ""}`);
      renderContext.ClearDiagnostics();
    }
  };
  requestAnimationFrame(tick);

  Object.assign(spike, {
    ready: true, state, canvas, job, renderContext, backend, meta,
    readCanvas: () => new Promise(resolve => { pendingRead = resolve; }),
    setYaw(degrees) { state.yaw = degrees * Math.PI / 180; },
    setTime(seconds) { state.time = seconds; if (HELD_YAW === null) state.yaw = seconds * 0.5; },
    status: () => job.status,
    debug: () => ({ projection: Array.from(Tr2Renderer.GetProjectionTransform()), view: Array.from(Tr2Renderer.GetViewTransform()), viewport: esm().GetViewport(), device: esm().GetDeviceViewport(), canvas: [ canvas.width, canvas.height ] })
  });
}

Main().catch(error =>
{
  spike.error = String(error?.stack ?? error);
  console.error("spike failed", error);
  document.getElementById("status").textContent = spike.error;
});
