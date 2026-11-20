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
//   backdrop=1   a textured full-screen quad behind the ship: a JPEG from a URL, a PNG through resMan
//                and a canvas drawn here, all read through samplers (effects/backdrop.fx)
//   views=N      N views a frame, each drawn by its own call into its own viewport of the canvas (a grid with
//                gutters cleared to a known colour); draw=now uses DrawNow(job) (default), draw=pump registers
//                the job and calls blue.os.PumpOS() per view. window.__spike.views reports job runs per frame.
//   lateload=1   after a few frames, loads a PNG through resMan while only PumpLoading() is called, then
//                stops drawing: the job must not run during the load and the canvas must keep its picture
//   filter=point the backdrop point-sampled instead of trilinear; zoom=N scales its UVs (N > 1 minifies)
import {
  blue, BlueScriptCallback, mat4, vec3, DepthStencilFormat, PixelFormat, ShaderType, TriBatchType,
  Tr2Renderer, PER_FRAME_VS, PER_FRAME_PS, Tr2RenderUtils, Tr2RenderTarget, Tr2DepthStencil, Tr2Mesh, Tr2MeshArea,
  ITr2Renderable, TriView, TriProjection, RawData, CjsConstantLayout, TriGeometryRes, Tr2Effect, Tr2EffectStateManager,
  Tr2RenderJobs, TriRenderJob, TriStepClear, TriStepPythonCB, TriStepRenderEffect, TriStepRenderObject,
  TriStepSetProjection, TriStepSetView, Tr2ConstantBufferAL, ShatteredBoot,
  LoadTexture, CreateTextureFromImage, UpdateTextureFromImage, DrawNow, PumpLoading, GetCanvasTarget
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
const BACKDROP = params.get("backdrop") === "1";
const FILTER_POINT = params.get("filter") === "point";
const ZOOM = Number(params.get("zoom") ?? 1);
const VIEWS = Math.max(0, Number(params.get("views") ?? 0) | 0);
const DRAW = params.get("draw") ?? "now";
const LATE_LOAD = params.get("lateload") === "1";
// The colour the canvas is cleared to between views: any pixel of it left in a view, or missing from a gutter, is a viewport fault.
const GUTTER = [ 0.2, 0.6, 0.4, 1 ];

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
  // The canvas as a render target: one call on both backends (also backend.GetCanvasTarget()).
  const canvasTarget = () => GetCanvasTarget(backend);

  // Blue is host-pumped: resources only finish loading while something calls PumpOS.
  let loading = true;
  const pump = () => { if (!loading) return; PumpLoading(); requestAnimationFrame(pump); };
  requestAnimationFrame(pump);

  const [ { geometry, meta }, hullEffect, normalEffect, paintEffect ] = await Promise.all([
    LoadHullGeometry(HULL), LoadEffect("hull"), LoadEffect("hullnormal"), LoadEffect("watercolour")
  ]);

  // Our own textures, three ways in: a JPEG by URL through the browser's decoder, a PNG through resMan
  // and the engine's reader, and a canvas drawn here and uploaded (then redrawn and uploaded again).
  let backdropEffect = null, drawnCanvas = null, drawnTexture = null;
  const DrawCanvas = seconds =>
  {
    const c = drawnCanvas.getContext("2d");
    c.clearRect(0, 0, 256, 256);
    c.fillStyle = "rgba(24, 30, 56, 0.82)";
    c.fillRect(8, 8, 240, 240);
    c.strokeStyle = "#f2ead8";
    c.lineWidth = 3;
    c.beginPath();
    for (let i = 0; i <= 64; i++) c.lineTo(16 + i * 3.5, 128 + Math.sin(i * 0.3 + seconds * 2) * 70);
    c.stroke();
    c.fillStyle = "#e25c3a";
    c.font = "700 30px Georgia, serif";
    c.fillText("canvas", 20, 46);
  };
  if (BACKDROP)
  {
    backdropEffect = await LoadEffect("backdrop");
    const backdropTexture = await LoadTexture("res:/textures/backdrop.jpg");
    const markerTexture = blue.resMan.GetResource("res:/textures/marker.png");
    await blue.resMan.Ready(markerTexture);
    if (!markerTexture.IsGood()) throw new Error("the PNG did not load through resMan");
    drawnCanvas = document.createElement("canvas");
    drawnCanvas.width = drawnCanvas.height = 256;
    DrawCanvas(0);
    drawnTexture = CreateTextureFromImage(drawnCanvas, { name: "drawn-canvas" });
    backdropEffect.SetParameter__TextureProvider("BackdropMap", backdropTexture);
    backdropEffect.SetParameter__TextureProvider("BackdropPointMap", backdropTexture);
    backdropEffect.SetParameter__TextureProvider("MarkerMap", markerTexture);
    backdropEffect.SetParameter__TextureProvider("CanvasMap", drawnTexture);
    backdropEffect.SetParameter__Vector4("BackdropTransform", [ ZOOM, ZOOM, 0, 0 ]);
    backdropEffect.SetParameter__Vector4("BackdropSettings", [ FILTER_POINT ? 1 : 0, 1, 0, 0 ]);
    paintEffect.SetParameter__Vector4("BackdropMix", [ 1, 0, 0, 0 ]);
    spike.textures = {
      backdrop: [ backdropTexture.GetWidth(), backdropTexture.GetHeight(), backdropTexture.GetTexture()?.GetTrueMipCount() ],
      marker: [ markerTexture.GetWidth(), markerTexture.GetHeight() ],
      canvas: [ drawnTexture.GetWidth(), drawnTexture.GetHeight() ]
    };
  }

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
  // state.view: the canvas rectangle being drawn ({ x, y, width, height, yaw, clear }), or null for the whole canvas.
  const state = { time: 0, yaw: HELD_YAW ?? 0, view: null, runs: 0 };
  const sceneViewport = () =>
  {
    if (state.view) esm().SetViewport({ x: 0, y: 0, width: state.view.width, height: state.view.height });
    else esm().SetFullScreenViewport();
  };

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
  const backdrop = new TriStepRenderEffect();
  backdrop.effect = backdropEffect;
  const clearCanvas = new TriStepClear();
  clearCanvas.color.set(GUTTER);
  clearCanvas.isColorCleared = clearCanvas.isDepthCleared = false;

  const job = new TriRenderJob();
  job.name = "ShatteredSpike";
  for (const step of [
    // Update: the camera, the ships.
    callback(() =>
    {
      state.runs++;
      if (state.view) state.yaw = state.view.yaw;
      const aspect = state.view ? state.view.width / state.view.height : canvas.width / canvas.height;
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
    callback(sceneViewport),
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
    callback(sceneViewport),
    renderFleet(normalEffect),
    // Pass 3: onto the canvas. The backdrop first when asked for, then the watercolour pass over both targets.
    callback(() =>
    {
      backend.al.SetRenderTarget(0, canvasTarget());
      backend.al.SetDepthStencil(null);
      esm().SetFullScreenViewport();
      // The first view of a frame clears the whole canvas to the gutter colour; the others must leave it alone.
      clearCanvas.isColorCleared = !!state.view?.clear;
      const rect = state.view;
      paintEffect.SetParameter__Vector4("ViewRect", rect ? [ rect.x, rect.y, rect.width, rect.height ] : [ 0, 0, 0, 0 ]);
      paintEffect.SetParameter__TextureAL("SceneColour", colourTarget.GetRenderTarget());
      paintEffect.SetParameter__TextureAL("SceneNormal", normalTarget.GetRenderTarget());
      // The canvas texture is redrawn and uploaded again twice a second.
      if (drawnTexture && !HOLD && Math.floor(state.time * 2) !== state.drawnAt)
      {
        state.drawnAt = Math.floor(state.time * 2);
        DrawCanvas(state.time);
        UpdateTextureFromImage(drawnTexture, drawnCanvas);
        spike.canvasUploads = (spike.canvasUploads ?? 1) + 1;
      }
    }),
    clearCanvas,
    // The viewport on the canvas, after the clear (which covers the whole target).
    callback(() => { if (state.view) esm().SetViewport({ x: state.view.x, y: state.view.y, width: state.view.width, height: state.view.height }); }),
    ...(BACKDROP ? [ backdrop ] : []),
    paint
  ]) job.steps.push(step);

  // The job is registered with the device unless each view is drawn by DrawNow(job).
  const registered = !(VIEWS && DRAW === "now");
  if (registered)
  {
    const jobs = device.GetRenderJobs() ?? new Tr2RenderJobs();
    jobs.recurring.push(job);
    device.SetRenderJobs(jobs);
  }
  // A grid of views with gutters, in canvas pixels.
  const views = [];
  if (VIEWS)
  {
    const gutter = 24, columns = Math.ceil(Math.sqrt(VIEWS)), rows = Math.ceil(VIEWS / columns);
    const width = Math.floor((canvas.width - gutter * (columns + 1)) / columns), height = Math.floor((canvas.height - gutter * (rows + 1)) / rows);
    for (let i = 0; i < VIEWS; i++)
      views.push({ x: gutter + (i % columns) * (width + gutter), y: gutter + Math.floor(i / columns) * (height + gutter), width, height, yaw: i * Math.PI * 2 / VIEWS + 0.5, clear: i === 0 });
    spike.views = { count: VIEWS, draw: DRAW, rects: views.map(v => [ v.x, v.y, v.width, v.height ]), gutter: GUTTER.map(v => Math.round(v * 255)), runsPerFrame: [] };
  }

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
    if (spike.frozen)
    {
      // Nothing is drawn any more; loading is still pumped. The canvas has to keep its last picture.
      PumpLoading();
      return;
    }
    if (VIEWS)
    {
      // Several views in one task, one call each. Loading is pumped once, without drawing.
      const runsBefore = state.runs;
      if (DRAW === "now") PumpLoading();
      for (const rect of views)
      {
        state.view = rect;
        if (DRAW === "now") DrawNow(job);
        else blue.os.PumpOS();
      }
      state.view = null;
      if (spike.views.runsPerFrame.length < 8) spike.views.runsPerFrame.push(state.runs - runsBefore);
    }
    else blue.os.PumpOS();
    const cpu = performance.now() - before;
    if (LATE_LOAD && spike.frames === 6 && !spike.lateLoad)
    {
      // A load that starts while the job is registered: only PumpLoading runs until it resolves.
      spike.lateLoad = { started: true };
      spike.frozen = true;
      const runsBefore = state.runs;
      const resource = blue.resMan.GetResource("res:/textures/marker.png");
      let pumps = 0;
      const count = setInterval(() => pumps++, 4);
      blue.resMan.Ready(resource).then(() =>
      {
        clearInterval(count);
        spike.lateLoad = { loaded: resource.IsGood(), size: [ resource.GetWidth(), resource.GetHeight() ], jobRunsDuringLoad: state.runs - runsBefore, registered };
      });
    }
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
      if (VIEWS)
      {
        // Every third pixel: inside a view nothing may be the gutter colour, outside everything must be.
        const px = (x, y) => { const o = (y * canvas.width + x) * 4; return [ data[o], data[o + 1], data[o + 2] ]; };
        const isGutter = c => Math.abs(c[0] - spike.views.gutter[0]) + Math.abs(c[1] - spike.views.gutter[1]) + Math.abs(c[2] - spike.views.gutter[2]) <= 3;
        let gutterInside = 0, pictureOutside = 0, insideSamples = 0, outsideSamples = 0;
        for (let y = 0; y < canvas.height; y += 3) for (let x = 0; x < canvas.width; x += 3)
        {
          const inside = views.some(v => x >= v.x && x < v.x + v.width && y >= v.y && y < v.y + v.height);
          const gutter = isGutter(px(x, y));
          if (inside) { insideSamples++; if (gutter) gutterInside++; }
          else { outsideSamples++; if (!gutter) pictureOutside++; }
        }
        spike.views.check = { insideSamples, gutterInside, outsideSamples, pictureOutside,
          edges: views.map(v => ({ justInside: px(v.x, v.y), justOutside: px(v.x - 1, v.y - 1), lastInside: px(v.x + v.width - 1, v.y + v.height - 1), firstOutside: px(v.x + v.width, v.y + v.height), centre: px(v.x + (v.width >> 1), v.y + (v.height >> 1)) })) };
      }
      const samples = Math.ceil(data.length / 28);
      // Luma statistics of the backdrop's checker as drawn. Magnified (zoom < 1), point sampling leaves two tones
      // (few mid greys) and linear filtering ramps between them (many).
      const region = (x0, y0, x1, y1) =>
      {
        let n = 0, total = 0, squares = 0, mid = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
        {
          const o = (y * canvas.width + x) * 4, luma = (data[o] * 3 + data[o + 1] * 6 + data[o + 2]) / 10;
          n++; total += luma; squares += luma * luma;
          if (luma > 90 && luma < 170) mid++;
        }
        return { mean: +(total / n).toFixed(2), deviation: +Math.sqrt(Math.max(0, squares / n - (total / n) ** 2)).toFixed(2), midShare: +(mid / n).toFixed(3) };
      };
      const at = (x, y) => { const o = (Math.floor(y * canvas.height) * canvas.width + Math.floor(x * canvas.width)) * 4; return [ data[o], data[o + 1], data[o + 2], data[o + 3] ]; };
      resolve({ width: canvas.width, height: canvas.height, distinctColours: colours.size, meanLuma: +(sum / samples).toFixed(2), darkShare: +(dark / samples).toFixed(4), corner: at(0.02, 0.02), centre: at(0.5, 0.5),
        ...(BACKDROP ? { checker: region(Math.ceil(70 / 1.5 / ZOOM), Math.ceil(70 / 1.5 / ZOOM), Math.floor(250 / 1.5 / ZOOM), Math.floor(250 / 1.5 / ZOOM)),
          marker: at(0.03 + 0.045, 0.62 + 0.08), drawn: at(0.79 + 0.02, 0.62 + 0.04) } : {}) });
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
