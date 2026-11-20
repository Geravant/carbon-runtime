// Shattered Reach engine-request proof page (requests.html): one check per request the game agents filed
// (carbon-port-docs 08, 09, 10), each mirrored to window.__spike.requests[name] = { ok, ... } so a test reads
// numbers, not pictures. Effects: ../effects/req/*.fx. Every shape is given straight in clip space.
//
//   washes    (M5 1)  a transparent pass blended INTO the scene's colour target, read by the full-screen paper pass;
//                     beside it the same washes written opaquely, as today, with the pale hole
//   subrect   (M5 2)  a sub-rectangle of a texture replaced (UpdateTextureFromImage rect / x,y)
//   spans     (M4 3, M5 3) Tr2CurveLineSet lines clipped to a span of their length, changed with no resubmit
//   release   (M4 1, M5 4) geometries made in memory: what dropping them holds, what ReleaseGeometry frees,
//                     and the engine's idle sweep
//   floats    (M3 1)  float data textures (rgba32f, rgba16f), Load-read, updated in part
//   loadcap   (M3 3)  LoadTexture maxSize; a canvas with no context as a texture
//   timing    (M3 2, M4 2) a GPU time per job (TimeJob / TimeJobNow)
//   camera    (M4 4)  EveCamera's fieldOfView with zoomCurve null, and OrbitCamera
//   leak, capacity (M3 4, 5)  a pass's AlphaBlendEnable = false after an additive step; InstanceStream
//   targets, halfResolution (skies 4, 3)  releasing render targets; a half-size draw with a filtered upsample
//
// URL: backend=webgl2 asks for WebGL2 only; half=1 keeps drawing the half-resolution job after the checks.
import {
  blue, BlueScriptCallback, PixelFormat, DepthStencilFormat, TriBatchType, Tr2RenderTarget, Tr2DepthStencil, Tr2Mesh, Tr2MeshArea,
  ITr2Renderable, RawData, CjsConstantLayout, TriGeometryRes, Tr2Effect, Tr2EffectStateManager, TriRenderJob, TriStepClear,
  TriStepPythonCB, TriStepRenderEffect, TriStepRenderObject, ShatteredBoot, DrawNow, PumpLoading, GetCanvasTarget, Tr2CurveLineSet,
  CreateTextureFromImage, UpdateTextureFromImage, LoadTexture, CreateTextureFromData, UpdateTextureFromData,
  ReleaseGeometry, ReleaseRenderTarget, GeometryPoolStats, RegisteredResourceCount, CurveLineSpans, TimeJob, TimeJobNow, GpuTimingMethod,
  EveCamera, OrbitCamera, CcpTime, TriDevice, InstanceStream, Tr2InstancedMesh
} from "@geravant/carbon-runtime-slim";

const params = new URLSearchParams(location.search);
const BACKEND = params.get("backend");
const spike = window.__spike = { ready: false, error: null, frames: 0, diagnostics: [], requests: {} };
const results = spike.requests;

RawData.RegisterLayouts({ ReqObject: { vs: { struct: "ReqObjectVSData", fields: { unused: { type: CjsConstantLayout.Types.VECTOR4 } } } } }, "ReqLayouts");
const objectData = { vs: RawData.create("ReqObjectVSData") };

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

const DECL = [
  { usage: "Position", usageIndex: 0, type: "Float32", elementCount: 3, offset: 0 },
  { usage: "TexCoord", usageIndex: 0, type: "Float32", elementCount: 4, offset: 12 }
];

// Axis-aligned rectangles in clip space, each with four per-corner TEXCOORD0 values.
function RectsGeometry(name, rects)
{
  const position = [], data = [], indices = [];
  for (const { x0, y0, x1, y1, corners } of rects)
  {
    const base = position.length / 3;
    [ [ x0, y0 ], [ x1, y0 ], [ x1, y1 ], [ x0, y1 ] ].forEach(([ x, y ], i) => { position.push(x, y, 0); data.push(...corners[i]); });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new TriGeometryRes();
  const ok = geometry.PrepareFromCmfData({ meshes: [ {
    name, decl: DECL,
    vertex: { position: new Float32Array(position), texcoord0: new Float32Array(data) },
    vertexCount: position.length / 3, indexBuffer: new Uint32Array(indices),
    areas: [ { name, firstElement: 0, elementCount: indices.length / 3 } ],
    bounds: { min: [ -1, -1, 0 ], max: [ 1, 1, 0 ] }, boundingSphere: [ 0, 0, 0, 2 ]
  } ] });
  if (!ok) throw new Error(`geometry ${name} refused`);
  return geometry;
}
const flat = (x0, y0, x1, y1, colour) => ({ x0, y0, x1, y1, corners: [ colour, colour, colour, colour ] });
// A quad showing a texture: texel coordinates 0..1 across it (v = 0 at the top), offset and scale.
const shown = (x0, y0, x1, y1, offset, scale) => ({ x0, y0, x1, y1, corners: [ [ 0, 1, offset, scale ], [ 1, 1, offset, scale ], [ 1, 0, offset, scale ], [ 0, 0, offset, scale ] ] });

function MeshOf(geometry, effect, batchType)
{
  const mesh = new Tr2Mesh();
  mesh.PySetGeometryRes(geometry);
  const area = new Tr2MeshArea();
  area.SetMaterial(effect);
  area.SetIndex(0);
  area.SetCount(1);
  mesh.AddArea(batchType, area);
  return mesh;
}

class Parts extends ITr2Renderable
{
  parts = [];   // { batchType, commit(accumulator, batchType) }
  GetPerObjectData() { return null; }
  GetBatches(accumulator, batchType)
  {
    let committed = false;
    for (const part of this.parts) if (part.batchType === batchType && part.enabled !== false) committed = part.commit(accumulator, batchType) || committed;
    return committed;
  }
  HasTransparentBatches() { return true; }
  GetSortValue() { return 0; }
}

// Colours and strengths of the wash check (straight colour, strength in alpha, as the game writes them).
const PAPER = [ 0.95, 0.92, 0.85 ];
const TERRITORY = [ 0.20, 0.40, 0.80, 0.50 ];
const WASH1 = [ 0.90, 0.20, 0.10, 0.60 ];
const WASH2 = [ 0.90, 0.80, 0.10, 0.50 ];
// Over, in the target: colour by the source's alpha, alpha by a + d (1 - a).
const over = (src, dst) => [ ...[ 0, 1, 2 ].map(k => src[k] * src[3] + dst[k] * (1 - src[3])), src[3] + dst[3] * (1 - src[3]) ];
const onPaper = c => [ 0, 1, 2 ].map(k => Math.round((PAPER[k] + (c[k] - PAPER[k]) * c[3]) * 255));

async function Main()
{
  const canvas = document.getElementById("view");
  canvas.width = Math.max(1, Math.round(canvas.clientWidth));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight));
  const W = canvas.width, H = canvas.height;

  const { backend, renderContext } = await ShatteredBoot({
    canvas, res: new URL("./res/", location.href), gpuTimer: true,
    preference: BACKEND ? [ BACKEND ] : [ "webgpu", "webgl2" ],
    effectPaths: { blit: "res:/graphics/effect/shattered/system/blit.fx", blitFiltered: "res:/graphics/effect/shattered/system/blitfiltered.fx" }
  });
  spike.backendName = spike.adapter = backend.name;

  let loading = true;
  const pump = () => { if (!loading) return; PumpLoading(); requestAnimationFrame(pump); };
  requestAnimationFrame(pump);
  const names = [ "req/territory", "req/wash", "req/washopaque", "req/paper", "req/spanline", "req/show", "req/show", "req/show", "req/show", "req/glow", "req/inst", "system/blitfiltered" ];
  const [ territoryFx, washFx, washOpaqueFx, paperFx, lineFx, showRgba8Fx, showF32Fx, showF16Fx, showCapFx, glowFx, instFx, upsampleFx ] = await Promise.all(names.map(LoadEffect));
  loading = false;

  const scene = new Parts();
  const add = (mesh, batchType) => { const part = { batchType, commit: (a, t) => mesh.GetBatches(a, t, objectData) }; scene.parts.push(part); return part; };

  // ---- washes (M5 request 1): the top half. Territory over all of it; left: washes blended in the transparent
  // pass; right: the same washes written opaquely after the territory (today's way).
  const washRects = dx => [ flat(-0.9 + dx, 0.2, -0.3 + dx, 0.8, WASH1), flat(-0.6 + dx, 0.2, -0.05 + dx, 0.8, WASH2) ];
  add(MeshOf(RectsGeometry("territory", [ flat(-1, 0, 1, 1, TERRITORY) ]), territoryFx, TriBatchType.TRIBATCHTYPE_OPAQUE), TriBatchType.TRIBATCHTYPE_OPAQUE);
  // Opaque washes after the territory: a second opaque step, so they are drawn after it whatever the effect sort does.
  const later = new Parts();
  const opaqueWashes = MeshOf(RectsGeometry("washes-opaque", washRects(1)), washOpaqueFx, TriBatchType.TRIBATCHTYPE_OPAQUE);
  later.parts.push({ batchType: TriBatchType.TRIBATCHTYPE_OPAQUE, commit: (a, t) => opaqueWashes.GetBatches(a, t, objectData) });
  // Two meshes, so the transparent list holds two batches in our order.
  add(MeshOf(RectsGeometry("wash1", [ washRects(0)[0] ]), washFx, TriBatchType.TRIBATCHTYPE_TRANSPARENT), TriBatchType.TRIBATCHTYPE_TRANSPARENT);
  add(MeshOf(RectsGeometry("wash2", [ washRects(0)[1] ]), washFx, TriBatchType.TRIBATCHTYPE_TRANSPARENT), TriBatchType.TRIBATCHTYPE_TRANSPARENT);

  // ---- leak (M3 request 4): a small additive stroke in the top right corner of the colour target, drawn by an
  // additive TriStepRenderObject right before the paper pass.
  add(MeshOf(RectsGeometry("glow", [ flat(0.96, 0.96, 1, 1, [ 0.02, 0.02, 0.02, 1 ]) ]), glowFx, TriBatchType.TRIBATCHTYPE_ADDITIVE), TriBatchType.TRIBATCHTYPE_ADDITIVE);

  // ---- capacity (M3 request 5): an InstanceStream drawing a row of small squares at y = -0.15, one per row.
  const stream = new InstanceStream({ minCapacity: 16 });
  stream.SetElementLayout([ { usage: "TEXCOORD", usageIndex: 0, type: "FLOAT32_4", name: "placement" } ]);
  const squares = n => Array.from({ length: n }, (_, i) => [ [ -0.95 + (i % 30) * 0.028, -0.15, 0.008, 0 ] ]);
  stream.SetData(squares(5));
  stream.UpdateData();
  const unitQuad = (() =>
  {
    const geometry = new TriGeometryRes();
    geometry.PrepareFromCmfData({ meshes: [ { name: "unit", decl: [ DECL[0] ], vertex: { position: new Float32Array([ -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0 ]) },
      vertexCount: 4, indexBuffer: new Uint32Array([ 0, 1, 2, 0, 2, 3 ]), areas: [ { name: "unit", firstElement: 0, elementCount: 2 } ],
      bounds: { min: [ -1, -1, 0 ], max: [ 1, 1, 0 ] }, boundingSphere: [ 0, 0, 0, 2 ] } ] });
    return geometry;
  })();
  const instanced = new Tr2InstancedMesh();
  instanced.PySetGeometryRes(unitQuad);
  instanced.SetInstanceGeometryRes(stream);
  {
    const area = new Tr2MeshArea();
    area.SetMaterial(instFx); area.SetIndex(0); area.SetCount(1);
    instanced.AddArea(TriBatchType.TRIBATCHTYPE_OPAQUE, area);
  }
  add(instanced, TriBatchType.TRIBATCHTYPE_OPAQUE);

  // ---- subrect (M5 request 2): a 64x64 RGBA8 texture, red; a 32x32 rect at 16,16 replaced from a full-size green
  // ImageData; an 8x8 blue ImageData written at 0,0; a 16x8 white rect from a canvas at 48,56.
  const red = new ImageData(64, 64);
  for (let i = 0; i < red.data.length; i += 4) red.data.set([ 220, 30, 30, 255 ], i);
  const field = CreateTextureFromImage(red, { mips: false, name: "subrect" });
  const green = new ImageData(64, 64);
  for (let i = 0; i < green.data.length; i += 4) green.data.set([ 30, 200, 40, 255 ], i);
  const blueTile = new ImageData(8, 8);
  for (let i = 0; i < blueTile.data.length; i += 4) blueTile.data.set([ 30, 40, 210, 255 ], i);
  const painted = new OffscreenCanvas(64, 64);
  const paint = painted.getContext("2d");
  paint.fillStyle = "#000"; paint.fillRect(0, 0, 64, 64);
  paint.fillStyle = "#fff"; paint.fillRect(48, 56, 16, 8);
  const subrectTimes = {};
  let t = performance.now();
  UpdateTextureFromImage(field, green, { rect: { x: 16, y: 16, width: 32, height: 32 }, mips: false });
  subrectTimes.rect32 = performance.now() - t;
  UpdateTextureFromImage(field, blueTile, { x: 0, y: 0, mips: false });
  UpdateTextureFromImage(field, painted, { rect: { x: 48, y: 56, width: 16, height: 8 }, mips: false });
  showRgba8Fx.SetParameter__TextureProvider("Shown", field);
  // Shown 1:1 in canvas pixels at the bottom left: 64 by 64 pixels.
  const px = (x, y) => [ x / W * 2 - 1, 1 - y / H * 2 ];
  const [ sx0, sy0 ] = px(8, H - 72), [ sx1, sy1 ] = px(72, H - 8);
  add(MeshOf(RectsGeometry("show-subrect", [ shown(sx0, sy1, sx1, sy0, 0, 1) ]), showRgba8Fx, TriBatchType.TRIBATCHTYPE_OPAQUE), TriBatchType.TRIBATCHTYPE_OPAQUE);

  // ---- floats (M3 request 1): rgba32f 2x1 holding values above 1000, read as (v - 1000); texel 1 rewritten in part.
  // rgba16f 2x1 from plain numbers (converted to half floats), read as (v - 2).
  const f32 = CreateTextureFromData(new Float32Array([ 1000.25, 1000.5, 1000.75, 1001, 0, 0, 0, 0 ]), 2, 1, { format: "rgba32f", name: "f32" });
  UpdateTextureFromData(f32, new Float32Array([ 1000.75, 1000.5, 1000.25, 1001 ]), { x: 1, y: 0, width: 1, height: 1 });
  const f16 = CreateTextureFromData([ 2.25, 2.5, 2.75, 3, 2.0625, 2.125, 2.9375, 3 ], 2, 1, { format: "rgba16f", name: "f16" });
  showF32Fx.SetParameter__TextureProvider("Shown", f32);
  showF16Fx.SetParameter__TextureProvider("Shown", f16);
  const [ fx0, fy0 ] = px(80, H - 40), [ fx1, fy1 ] = px(144, H - 8);
  add(MeshOf(RectsGeometry("show-f32", [ shown(fx0, fy1, fx1, fy0, 1000, 1) ]), showF32Fx, TriBatchType.TRIBATCHTYPE_OPAQUE), TriBatchType.TRIBATCHTYPE_OPAQUE);
  const [ gx0, gy0 ] = px(80, H - 72), [ gx1, gy1 ] = px(144, H - 40);
  add(MeshOf(RectsGeometry("show-f16", [ shown(gx0, gy1, gx1, gy0, 2, 1) ]), showF16Fx, TriBatchType.TRIBATCHTYPE_OPAQUE), TriBatchType.TRIBATCHTYPE_OPAQUE);

  // ---- loadcap (M3 request 3 and the canvas finding): the 1536-wide backdrop capped at 256; a context-less canvas.
  const capped = await LoadTexture("res:/textures/backdrop.jpg", { maxSize: 256, name: "capped" });
  const full = await LoadTexture("res:/textures/backdrop.jpg", { mips: false, name: "full" });
  let blankCanvas = null;
  try
  {
    const bare = document.createElement("canvas");
    bare.width = 32; bare.height = 16;
    const texture = CreateTextureFromImage(bare, { name: "bare" });
    blankCanvas = { ok: texture.IsGood() && texture.GetWidth() === 32, width: texture.GetWidth(), height: texture.GetHeight(),
      contextCreated: false };
  }
  catch (error)
  {
    blankCanvas = { ok: false, error: String(error) };
  }
  showCapFx.SetParameter__TextureProvider("Shown", capped);
  const [ cx0, cy0 ] = px(152, H - 72), [ cx1, cy1 ] = px(152 + capped.GetWidth() / 2, H - 72 + capped.GetHeight() / 2);
  add(MeshOf(RectsGeometry("show-capped", [ shown(cx0, cy1, cx1, cy0, 0, 1) ]), showCapFx, TriBatchType.TRIBATCHTYPE_OPAQUE), TriBatchType.TRIBATCHTYPE_OPAQUE);
  results.loadcap = {
    ok: capped.GetWidth() === 256 && capped.GetHeight() === Math.round(full.GetHeight() * 256 / full.GetWidth()) && capped.GetTexture().GetTrueMipCount() === 9 && blankCanvas.ok,
    full: [ full.GetWidth(), full.GetHeight() ], capped: [ capped.GetWidth(), capped.GetHeight() ], cappedMips: capped.GetTexture().GetTrueMipCount(), blankCanvas
  };

  // ---- spans (M4 request 3, M5 request 3): the bottom right. Three lines; spans changed with no SubmitChanges.
  const lines = new Tr2CurveLineSet();
  lines.SetLineEffect(lineFx);
  const L = { y0: -0.3, y1: -0.55, y2: -0.8, x0: 0.1, x1: 0.9 };
  const id0 = lines.AddStraightLine([ L.x0, L.y0, 0 ], [ 1, 0.8, 0.2, 1 ], [ L.x1, L.y0, 0 ], [ 1, 0.8, 0.2, 1 ], 0.02);
  const id1 = lines.AddStraightLine([ L.x0, L.y1, 0 ], [ 0.2, 0.9, 1, 1 ], [ L.x1, L.y1, 0 ], [ 0.2, 0.9, 1, 1 ], 0.02);
  const id2 = lines.AddCurvedLineCrt([ L.x0, L.y2, 0 ], [ 1, 0.3, 0.6, 1 ], [ L.x1, L.y2, 0 ], [ 1, 0.3, 0.6, 1 ], [ 0.5, L.y2 - 0.1, 0 ], 0.02, 16);
  lines.SubmitChanges();
  const spans = new CurveLineSpans();
  spans.Bind(lineFx);
  spans.Set(id0, 0.25, 0.75);
  spans.Set(id1, 0, 0.5);
  spans.Set(id2, 1, 0);   // hidden
  spans.Upload();
  let fills = 0;
  const fill = lines.FillVertexBuffer.bind(lines);
  lines.FillVertexBuffer = () => { fills++; return fill(); };
  scene.parts.push({ batchType: TriBatchType.TRIBATCHTYPE_TRANSPARENT, commit: (a, type) => { lines.GetBatches(a, type, objectData); return true; } });

  // ---- targets and the job: opaque, then transparent into the colour target; the paper pass onto the canvas.
  const colourTarget = new Tr2RenderTarget(), depth = new Tr2DepthStencil();
  colourTarget.Create(W, H, 1, PixelFormat.PIXEL_FORMAT_R16G16B16A16_FLOAT);
  depth.Create(W, H, DepthStencilFormat.DSFMT_D32F, 1, 0, 0, renderContext);
  const esm = () => renderContext.GetEffectStateManager();
  const callback = fn => { const step = new TriStepPythonCB(); step.callback = BlueScriptCallback.from(fn); return step; };
  const clear = new TriStepClear();
  clear.color.set([ 0, 0, 0, 0 ]);
  clear.depth = 1;
  clear.isColorCleared = clear.isDepthCleared = true;
  const draw = (kind, renderable = scene) => { const step = new TriStepRenderObject(); step.renderable = renderable; step.renderDecal = step.renderAdditive = false;
    step.renderOpaque = kind === "opaque"; step.renderTransparent = kind === "transparent"; step.renderAdditive = kind === "additive"; return step; };
  const paperStep = new TriStepRenderEffect();
  paperStep.effect = paperFx;
  const job = new TriRenderJob();
  job.name = "ShatteredRequests";
  for (const step of [
    callback(() => { esm().SetRenderTarget(0, colourTarget.GetRenderTarget()); esm().SetDepthStencilBuffer(depth.GetDepthStencil()); esm().SetFullScreenViewport(); }),
    clear, draw("opaque"), draw("opaque", later), draw("transparent"), draw("additive"),
    callback(() => { backend.al.SetRenderTarget(0, GetCanvasTarget(backend)); backend.al.SetDepthStencil(null); esm().SetFullScreenViewport();
      paperFx.SetParameter__TextureAL("SceneColour", colourTarget.GetRenderTarget()); }),
    // Twice: a blend left on by the additive pass would add the second picture onto the first.
    paperStep, paperStep
  ]) job.steps.push(step);

  // A canvas read inside the frame that drew it.
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  let pixels = null;
  const frame = () =>
  {
    PumpLoading();
    spans.Upload();
    DrawNow(spike.loopJob ?? job);
    spike.frames++;
    probe.canvas.width = W; probe.canvas.height = H;
    probe.drawImage(canvas, 0, 0);
    pixels = probe.getImageData(0, 0, W, H).data;
    const diagnostics = renderContext.GetDiagnostics();
    if (diagnostics.length)
    {
      for (const d of diagnostics) if (spike.diagnostics.length < 20) spike.diagnostics.push(`${d.type}: ${d.error?.stack ?? d.error ?? d.message ?? ""}`);
      renderContext.ClearDiagnostics();
    }
  };
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => { frame(); resolve(); }));
  const at = (x, y) => { const o = (Math.round(y) * W + Math.round(x)) * 4; return [ pixels[o], pixels[o + 1], pixels[o + 2] ]; };
  const ndc = (x, y) => at((x * 0.5 + 0.5) * (W - 1), (1 - (y * 0.5 + 0.5)) * (H - 1));
  const near = (a, b, tolerance = 3) => a.every((v, k) => Math.abs(v - b[k]) <= tolerance);
  // Wait for the first complete picture: on WebGL2 programs may still be linking (parallel shader compile) for the
  // first frames, and a draw with an unlinked program is skipped. Counted, not timed.
  let warmup = 0;
  do { await nextFrame(); warmup++; } while (warmup < 600 && (ndc(-0.5, -0.05)[0] === 0 || at(40, H - 40)[1] === 0));
  for (let i = 0; i < 10; i++) await nextFrame();
  spike.warmupFrames = warmup;

  // ---- washes: measured against the over operator.
  {
    const t = TERRITORY, w1t = over(WASH1, t), both = over(WASH2, w1t), w2t = over(WASH2, t);
    const expect = { territory: onPaper(t), wash1: onPaper(w1t), overlap: onPaper(both), wash2: onPaper(w2t),
      opaqueWash1: onPaper(WASH1), opaqueOverlap: onPaper(WASH2) };
    const got = { territory: ndc(-0.5, 0.9), wash1: ndc(-0.75, 0.5), overlap: ndc(-0.45, 0.5), wash2: ndc(-0.2, 0.5),
      opaqueWash1: ndc(0.25, 0.5), opaqueOverlap: ndc(0.55, 0.5), paper: ndc(-0.5, -0.05) };
    results.washes = {
      ok: [ "territory", "wash1", "overlap", "wash2", "opaqueWash1", "opaqueOverlap" ].every(k => near(got[k], expect[k])),
      expected: expect, measured: got,
      strengthInTarget: { territory: t[3], wash1OverTerritory: +w1t[3].toFixed(3), bothOverTerritory: +both[3].toFixed(3), opaqueWash1: WASH1[3], opaqueOverlap: WASH2[3] },
      note: "blended (left): each wash adds strength (0.5, 0.8, 0.9) and mixes its pigment over what is there; opaque (right, today): the later stroke replaces everything, so the overlap has less strength (0.5) than the wash it lies on (0.6) and the territory under it is gone - the pale hole"
    };
  }

  // ---- leak: the paper pass writes the canvas opaquely each frame, so a pixel must not change between frames.
  {
    const first = ndc(-0.5, 0.9), firstPaper = ndc(-0.5, -0.05);
    for (let i = 0; i < 5; i++) await nextFrame();
    const later5 = ndc(-0.5, 0.9), laterPaper = ndc(-0.5, -0.05);
    results.leak = { ok: near(first, later5, 1) && near(firstPaper, laterPaper, 1), territoryPixel: [ first, later5 ], paperPixel: [ firstPaper, laterPaper ],
      note: "a TriStepRenderObject with renderAdditive runs right before the full-screen paper pass (AlphaBlendEnable = false); the canvas must hold the same picture 5 frames later" };
  }

  // ---- capacity: counts change every frame; the allocation is made once per power of two outgrown.
  {
    const square = i => ndc(-0.95 + i * 0.028, -0.15);
    const dark = c => c[0] < 60;
    const log = [];
    for (const n of [ 5, 12, 16, 3, 9, 17, 30, 2, 31, 6 ])
    {
      stream.SetData(squares(n));
      stream.UpdateData();
      await nextFrame();
      log.push({ rows: n, capacity: stream.GetCapacity(), drawnCount: stream.GetInstanceData().count, lastDrawn: n <= 30 ? dark(square(n - 1)) : null,
        nextEmpty: n < 30 ? !dark(square(n)) : null });
    }
    results.capacity = { ok: stream.allocations === 2 && log.every(r => r.drawnCount === r.rows && r.lastDrawn !== false && r.nextEmpty !== false),
      allocationsMade: stream.allocations, log,
      note: "minCapacity 16: rows 5..16 share one 16-row allocation, 17..31 one 32-row allocation; Tr2RuntimeInstanceData would have reallocated at every change of count" };
  }

  // ---- subrect: the 64x64 picture drawn 1:1 at (8, H-72).
  {
    const p = (x, y) => at(8 + x, H - 72 + y);
    const got = { redCorner: p(60, 2), green: p(32, 32), greenEdge: p(16, 16), redOutsideEdge: p(15, 40), blue: p(4, 4), white: p(56, 60), redBelowWhite: p(44, 60) };
    const want = { redCorner: [ 220, 30, 30 ], green: [ 30, 200, 40 ], greenEdge: [ 30, 200, 40 ], redOutsideEdge: [ 220, 30, 30 ], blue: [ 30, 40, 210 ], white: [ 255, 255, 255 ], redBelowWhite: [ 220, 30, 30 ] };
    results.subrect = { ok: Object.keys(want).every(k => near(got[k], want[k])), measured: got, expected: want, rect32Ms: +subrectTimes.rect32.toFixed(3) };
  }

  // ---- floats.
  {
    const got = { f32texel0: at(80 + 16, H - 24), f32texel1: at(80 + 48, H - 24), f16texel0: at(80 + 16, H - 56), f16texel1: at(80 + 48, H - 56) };
    const v = c => c.map(x => Math.round(x * 255));
    const want = { f32texel0: v([ 0.25, 0.5, 0.75 ]), f32texel1: v([ 0.75, 0.5, 0.25 ]), f16texel0: v([ 0.25, 0.5, 0.75 ]), f16texel1: v([ 0.0625, 0.125, 0.9375 ]) };
    results.floats = { ok: Object.keys(want).every(k => near(got[k], want[k], 2)), measured: got, expected: want,
      note: "values above 1000 survive (an 8-bit texture would hold 1.0); texel 1 of the rgba32f texture was written by a 1x1 UpdateTextureFromData" };
  }

  // ---- spans: sample along each line at s = 0.1, 0.5, 0.9; change spans, draw again, sample again.
  {
    const along = (y, s) => ndc(L.x0 + (L.x1 - L.x0) * s, y);
    const lit = c => near(c, PAPER.map(v => Math.round(v * 255)), 6) ? 0 : 1;
    const S = [ 0.1, 0.35, 0.65, 0.9 ];
    const sample = () => ({ line0: S.map(s => lit(along(L.y0, s))), line1: S.map(s => lit(along(L.y1, s))),
      line2: [ lit(ndc(0.5, L.y2 - 0.025)) ] });
    const before = sample();
    const fillsBefore = fills;
    spans.Set(id0, 0, 1);
    spans.Set(id1, 0.5, 1);
    spans.Set(id2, 0, 1);
    await nextFrame();
    const after = sample();
    results.spans = {
      ok: JSON.stringify(before) === JSON.stringify({ line0: [ 0, 1, 1, 0 ], line1: [ 1, 1, 0, 0 ], line2: [ 0 ] })
        && after.line0.join() === "1,1,1,1" && after.line1.join() === "0,0,1,1" && after.line2.join() === "1" && fills === fillsBefore,
      before, after, vertexBufferRefills: fills - fillsBefore,
      note: "1 = line drawn at s = 0.1, 0.35, 0.65, 0.9 along it (line2: its middle). Before: line0 span 0.25..0.75, line1 0..0.5, line2 hidden (1..0). After: 0..1, 0.5..1, 0..1, with no SubmitChanges"
    };
  }

  // ---- release: geometries made in memory, each drawn once (that is when the engine allocates its slices).
  {
    const off = flat(1.5, 1.5, 1.6, 1.6, [ 1, 1, 1, 1 ]);   // outside the view: drawn, never seen
    const batch = (count, tag) => Array.from({ length: count }, (_, i) =>
    {
      const geometry = RectsGeometry(`${tag}${i}`, [ off, off ]);
      return { geometry, mesh: MeshOf(geometry, territoryFx, TriBatchType.TRIBATCHTYPE_OPAQUE) };
    });
    const drawOnce = async items =>
    {
      const part = { batchType: TriBatchType.TRIBATCHTYPE_OPAQUE, commit: (a, t) => { let c = false; for (const it of items) c = it.mesh.GetBatches(a, t, objectData) || c; return c; } };
      scene.parts.push(part);
      await nextFrame();
      scene.parts.splice(scene.parts.indexOf(part), 1);
    };
    const start = GeometryPoolStats(), startRegistered = RegisteredResourceCount();
    let items = batch(300, "kept");
    await drawOnce(items);
    const drawn = GeometryPoolStats();
    for (const it of items) ReleaseGeometry(it.geometry);
    items = null;
    const released = GeometryPoolStats(), releasedRegistered = RegisteredResourceCount();
    let again = batch(300, "again");
    await drawOnce(again);
    const reused = GeometryPoolStats();
    for (const it of again) ReleaseGeometry(it.geometry);
    again = null;
    // Dropped without a release: the pool keeps their slices reserved, with nothing left to free them.
    let dropped = batch(300, "dropped");
    await drawOnce(dropped);
    dropped = null;
    for (let i = 0; i < 3; i++) await nextFrame();
    const afterDrop = GeometryPoolStats(), afterDropRegistered = RegisteredResourceCount();
    results.release = {
      ok: drawn.allocations === start.allocations + 900 && released.allocations === start.allocations && reused.allocations === drawn.allocations
        && reused.blocks === drawn.blocks && afterDrop.allocations === start.allocations + 900,
      start, drawn300: drawn, afterRelease: released, drawnAgain300: reused, dropped300WithoutRelease: afterDrop,
      registered: { start: startRegistered, afterRelease: releasedRegistered, afterDrop: afterDropRegistered },
      note: "900 = 300 geometries x 3 slices (vertices, indices, reversed indices). Dropping references frees nothing; ReleaseGeometry gives the slices back and the next 300 reuse them (no new block)"
    };
  }

  // ---- the idle sweep: what happens to in-memory resources a frame stops drawing (TriDevice.resourceIdleRule seconds
  // of active time, checked every resourceSweepInterval). Shortened here from 30 s / 60 s to 0.3 s / 0.3 s.
  {
    const rule = TriDevice.resourceIdleRule, interval = TriDevice.resourceSweepInterval;
    const geometry = RectsGeometry("idle", [ flat(1.5, 1.5, 1.6, 1.6, [ 1, 1, 1, 1 ]) ]);
    const mesh = MeshOf(geometry, territoryFx, TriBatchType.TRIBATCHTYPE_OPAQUE);
    const image = new ImageData(4, 4);
    image.data.fill(255);
    const texture = CreateTextureFromImage(image, { name: "idle" });
    const data = CreateTextureFromData(new Float32Array(16), 4, 1, { name: "idle data" });
    // The same texture without the fork's guard, to show what the sweep would do to it.
    const unguarded = CreateTextureFromImage(image, { name: "idle unguarded" });
    unguarded._neverPurge = false;
    unguarded.IsGood();
    const target = new Tr2RenderTarget();
    target.Create(8, 8, 1, PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM);
    const part = { batchType: TriBatchType.TRIBATCHTYPE_OPAQUE, commit: (a, t) => mesh.GetBatches(a, t, objectData) };
    scene.parts.push(part);
    await nextFrame();
    scene.parts.splice(scene.parts.indexOf(part), 1);
    texture.IsGood(); data.IsGood();
    target.GetRenderTarget();
    const targetBefore = target.IsValid();
    TriDevice.resourceIdleRule = 0.3;
    TriDevice.resourceSweepInterval = 0.3;
    const begin = performance.now();
    while (performance.now() - begin < 1500) await nextFrame();
    TriDevice.resourceIdleRule = rule;
    TriDevice.resourceSweepInterval = interval;
    const state = {
      geometry: { good: geometry.IsGood(), meshData: !!geometry.GetCMFData?.(), neverPurge: !!geometry._neverPurge },
      imageTexture: { texture: !!texture.GetTexture(), neverPurge: !!texture._neverPurge },
      dataTexture: { texture: !!data.GetTexture(), neverPurge: !!data._neverPurge },
      unguardedImageTexture: { texture: !!unguarded.GetTexture(), good: unguarded.IsGood() },
      renderTarget: { validBefore: targetBefore, validAfter: target.IsValid(), neverPurge: !!target._neverPurge }
    };
    // Back on screen: does the geometry draw again?
    scene.parts.push(part);
    await nextFrame();
    state.geometry.drawsAgain = geometry.IsGood();
    state.renderTarget.validAfterOneTick = target.IsValid();
    scene.parts.splice(scene.parts.indexOf(part), 1);
    results.idleSweep = { ok: state.geometry.meshData && state.imageTexture.texture && state.dataTexture.texture, state };
  }

  // ---- targets (skies request 4): releasing a render target and a depth surface.
  {
    const a = new Tr2RenderTarget(), b = new Tr2RenderTarget(), d = new Tr2DepthStencil();
    a.Create(64, 64, 1, PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM);
    b.Create(64, 64, 1, PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM);
    d.Create(64, 64, DepthStencilFormat.DSFMT_D32F, 1, 0, 0, renderContext);
    const before = [ a.IsValid(), b.IsValid(), d.IsValid() ];
    a.ReleaseResources();                       // no argument: nothing happens
    ReleaseRenderTarget(b);
    ReleaseRenderTarget(d);
    for (let i = 0; i < 3; i++) await nextFrame();
    const after = { releaseResourcesNoArgument: a.IsValid(), releaseRenderTarget: b.IsValid(), depthReleased: d.IsValid() };
    b.Create(32, 32, 1, PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM);
    results.targets = { ok: before.every(Boolean) && after.releaseResourcesNoArgument && !after.releaseRenderTarget && !after.depthReleased && b.IsValid() && b.GetWidth() === 32,
      before, after, createdAgain: [ b.IsValid(), b.GetWidth() ],
      note: "ReleaseResources() with no storage mask is a no-op; ReleaseRenderTarget (Destroy + leave the registry) frees for good and stays freed over device ticks; Create makes it again" };
    ReleaseRenderTarget(a);
    ReleaseRenderTarget(b);
  }

  // ---- half resolution (skies request 3): the same scene into a half-size target, the paper pass into a second
  // half-size target, then a filtered blit (our blitfiltered.fx, MIN_MAG_MIP_LINEAR) up to the canvas.
  {
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    const halfColour = new Tr2RenderTarget(), halfPaper = new Tr2RenderTarget(), halfDepth = new Tr2DepthStencil();
    halfColour.Create(hw, hh, 1, PixelFormat.PIXEL_FORMAT_R16G16B16A16_FLOAT);
    halfPaper.Create(hw, hh, 1, PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM);
    halfDepth.Create(hw, hh, DepthStencilFormat.DSFMT_D32F, 1, 0, 0, renderContext);
    const halfPaperStep = new TriStepRenderEffect();
    halfPaperStep.effect = paperFx;
    const upsample = new TriStepRenderEffect();
    upsample.effect = upsampleFx;
    const halfJob = new TriRenderJob();
    halfJob.name = "ShatteredHalf";
    for (const step of [
      callback(() => { esm().SetRenderTarget(0, halfColour.GetRenderTarget()); esm().SetDepthStencilBuffer(halfDepth.GetDepthStencil());
        // SetFullScreenViewport is the device's (canvas) size: a smaller target needs its own viewport.
        esm().SetViewport({ x: 0, y: 0, width: hw, height: hh, minZ: 0, maxZ: 1 }); }),
      clear,
      callback(() => esm().SetViewport({ x: 0, y: 0, width: hw, height: hh, minZ: 0, maxZ: 1 })),
      draw("opaque"), draw("opaque", later), draw("transparent"),
      callback(() => { esm().SetRenderTarget(0, halfPaper.GetRenderTarget()); esm().SetDepthStencilBuffer(null); esm().SetViewport({ x: 0, y: 0, width: hw, height: hh, minZ: 0, maxZ: 1 });
        paperFx.SetParameter__TextureAL("SceneColour", halfColour.GetRenderTarget()); }),
      halfPaperStep,
      // The canvas bound THROUGH the effect state manager: it then learns the canvas's size. Bound with backend.al, the
      // manager keeps the half-size target's extent, clips the viewport to it and scales the blit's coordinates by it.
      callback(() => { esm().SetRenderTarget(0, GetCanvasTarget(backend)); esm().SetDepthStencilBuffer(null); esm().SetFullScreenViewport();
        upsampleFx.SetParameter__TextureAL("BlitSource", halfPaper.GetRenderTarget()); }),
      upsample
    ]) halfJob.steps.push(step);
    const full = { territory: ndc(-0.5, 0.9), overlap: ndc(-0.45, 0.5), opaqueOverlap: ndc(0.55, 0.5) };
    const cost = [];
    for (let i = 0; i < 3; i++) cost.push((await TimeJob(job)).gpuMs, (await TimeJob(halfJob)).gpuMs);
    PumpLoading();
    DrawNow(halfJob);
    probe.drawImage(canvas, 0, 0);
    pixels = probe.getImageData(0, 0, W, H).data;
    const half = { territory: ndc(-0.5, 0.9), overlap: ndc(-0.45, 0.5), opaqueOverlap: ndc(0.55, 0.5) };
    results.halfResolution = { ok: Object.keys(full).every(k => near(full[k], half[k], 3)), fullResolution: full, halfThenUpsampled: half,
      gpuMs: { full: cost.filter((_, i) => i % 2 === 0).map(v => +v.toFixed(3)), half: cost.filter((_, i) => i % 2 === 1).map(v => +v.toFixed(3)) },
      note: "flat regions match the full-resolution picture after a filtered upsample; edges soften, as they should" };
    if (params.get("half") === "1") spike.loopJob = halfJob;
    else { ReleaseRenderTarget(halfColour); ReleaseRenderTarget(halfPaper); ReleaseRenderTarget(halfDepth); }
  }

  // ---- timing: per-job GPU time.
  {
    const runs = [];
    for (let i = 0; i < 6; i++)
    {
      PumpLoading();
      runs.push(await TimeJob(job));
      spike.frames++;
    }
    const blocking = [];
    for (let i = 0; i < 4; i++) blocking.push(await TimeJobNow(job));
    const ms = list => list.map(r => r.gpuMs === null ? null : +r.gpuMs.toFixed(3));
    results.timing = { ok: runs.slice(1).every(r => r.gpuMs > 0) && blocking.every(r => r.gpuMs > 0), method: GpuTimingMethod(),
      gpuMs: ms(runs), cpuMs: runs.map(r => +r.cpuMs.toFixed(3)), submitsPerJob: runs[0].submits, ticks: runs[0].ticks, blocking: { method: blocking[0].method, gpuMs: ms(blocking) },
      size: [ W, H ] };
  }

  // ---- camera: EveCamera with zoomCurve null, and OrbitCamera, at a 1.6 and a 16:9 aspect.
  {
    const vertical = camera => +(2 * Math.atan(1 / camera.projectionMatrix.transform[5])).toFixed(6);
    const run = (make, fov, aspect) =>
    {
      const camera = make();
      camera.zoomCurve = null;
      camera.fieldOfView = fov;
      camera.translationFromParent = 10;
      camera.idleMove = false;
      for (let i = 1; i <= 3; i++) camera.Update(CcpTime.timeFromDouble(i / 60), aspect);
      return vertical(camera);
    };
    const table = {};
    for (const fov of [ 0.5, 0.75, 1.2 ])
      table[fov] = { eveAt1_6: run(() => new EveCamera(), fov, 1.6), eveAt16_9: run(() => new EveCamera(), fov, 16 / 9),
        orbitAt16_9: run(() => new OrbitCamera(), fov, 16 / 9), orbitAt1_6: run(() => new OrbitCamera(), fov, 1.6), orbitAt4_3: run(() => new OrbitCamera(), fov, 4 / 3) };
    const curved = new EveCamera();
    curved.fieldOfView = 0.5;
    curved.idleMove = false;
    for (let i = 1; i <= 3; i++) curved.Update(CcpTime.timeFromDouble(i / 60), 1.5);
    const seconds = new OrbitCamera();
    seconds.fieldOfView = 0.6;
    seconds.UpdateSeconds(1.5, 2.2);
    const close = (a, b) => Math.abs(a - b) < 1e-5;
    results.camera = {
      ok: Object.entries(table).every(([ fov, r ]) => close(r.eveAt1_6, +fov) && close(r.orbitAt16_9, +fov) && close(r.orbitAt1_6, +fov) && close(r.orbitAt4_3, +fov))
        && close(vertical(seconds), 0.6),
      verticalFovFromProjection: table, orbitSecondsAt2_2: vertical(seconds),
      withDefaultZoomCurve: { asked: 0.5, fieldOfViewAfter: +curved.fieldOfView.toFixed(6) },
      note: "EveCamera honours fieldOfView (zoomCurve null) up to aspect 1.6; wider, it narrows the vertical by 1.6/aspect (Carbon's clamp). OrbitCamera holds it at every aspect."
    };
  }

  spike.allOk = Object.values(results).every(r => r.ok);
  spike.ready = true;
  // Keep drawing, for screenshots.
  const loop = () => { frame(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  Object.assign(spike, {
    readCanvas: async () => { await new Promise(requestAnimationFrame); const colours = new Set(); for (let i = 0; i < pixels.length; i += 28) colours.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]); return { width: W, height: H, distinctColours: colours.size }; },
    setYaw() {}, status: () => job.status
  });
}

Main().catch(error =>
{
  spike.error = String(error?.stack ?? error);
  console.error("requests failed", error);
  document.getElementById("status").textContent = spike.error;
});
