// Shattered Reach capability page: small proofs of what a 3D space scene needs from the engine,
// all with our own effects (../effects/scene/*.fx) and no EVE content:
//   - a sphere with our own shader and our own texture (a planet);
//   - instanced drawing: hundreds of markers in one draw (Tr2InstancedMesh + Tr2RuntimeInstanceData);
//   - lines and curves (Tr2CurveLineSet with our line effect);
//   - particles (Tr2ParticleSystem fed by a Tr2DynamicEmitter, drawn with our effect);
//   - opaque, alpha-blended and additive passes with depth-write control from the effects;
//   - picking: a world ray from a pixel (the engine's helpers) tested against our own bounds;
//   - cameras: the engine's orbit camera (EveCamera) or plain TriView / TriProjection.
//
// URL parameters:
//   markers=N      how many instanced markers (default 400)
//   camera=orbit   our own orbit maths on TriView / TriProjection (default)
//   camera=eve     the engine's orbit camera (EveCamera), updated by hand with no scene driver
//   camera=chase   our own chase camera: follows a point flying the lane curve, with lag
//   camera=free    our own free camera: a position and a heading, flying past the planet
//   only=a,b       draw only these parts: planet, markers, lines, particles
//   backend=webgl2 ask for WebGL2 only
//   hold=1         time only moves through window.__spike.setTime
import {
  blue, BlueScriptCallback, mat4, vec3, DepthStencilFormat, PixelFormat, ShaderType, TriBatchType,
  Tr2Renderer, PER_FRAME_VS, PER_FRAME_PS, Tr2RenderUtils, Tr2RenderTarget, Tr2DepthStencil, Tr2Mesh, Tr2MeshArea,
  ITr2Renderable, TriView, TriProjection, RawData, CjsConstantLayout, TriGeometryRes, Tr2Effect, Tr2EffectStateManager,
  TriRenderJob, TriStepClear, TriStepPythonCB, TriStepRenderEffect, TriStepRenderObject, TriStepSetProjection, TriStepSetView,
  Tr2ConstantBufferAL, ShatteredBoot, CreateTextureFromImage, DrawNow, PumpLoading, GetCanvasTarget,
  Tr2InstancedMesh, Tr2RuntimeInstanceData, Tr2CurveLineSet, Tr2ParticleSystem, Tr2ParticleElementDeclaration,
  Tr2DynamicEmitter, Tr2SphereShapeAttributeGenerator, Tr2RandomUniformAttributeGenerator,
  EveCamera, CcpTime, screenToProjection, convertProjectionCoordToWorldPickRay, ray3
} from "@geravant/carbon-runtime-slim";

const params = new URLSearchParams(location.search);
const MARKERS = Math.max(1, Number(params.get("markers") ?? 400) | 0);
const CAMERA = params.get("camera") ?? "orbit";
const ONLY = params.get("only") ? new Set(params.get("only").split(",")) : null;
const HOLD = params.get("hold") === "1";
const BACKEND = params.get("backend");
const shows = part => !ONLY || ONLY.has(part);

const spike = window.__spike = { ready: false, error: null, frames: 0, firstFrameMs: null, diagnostics: [], scene: {} };
const T0 = performance.now();

const { Types, Identity } = CjsConstantLayout;
RawData.RegisterLayouts({
  ScenePerFrame: {
    vs: { struct: "ScenePerFrameVSData", fields: {
      ViewProjectionMat: { type: Types.MATRIX4, default: Identity },
      CameraRight: { type: Types.VECTOR4 },
      CameraUp: { type: Types.VECTOR4 },
      Viewport: { type: Types.VECTOR4 }
    } },
    ps: { struct: "ScenePerFramePSData", fields: {
      LightDirection: { type: Types.VECTOR4 },
      Time: { type: Types.VECTOR4 }
    } }
  },
  SceneObject: { vs: { struct: "SceneObjectVSData", fields: { worldTransform: { type: Types.MATRIX4, default: Identity } } } }
}, "SceneLayouts");

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

function Geometry(name, mesh)
{
  const geometry = new TriGeometryRes();
  if (!geometry.PrepareFromCmfData({ meshes: [ { name, ...mesh } ] })) throw new Error(`geometry ${name} was refused`);
  return geometry;
}

// A latitude-longitude sphere: position, normal, one UV set.
function SphereGeometry(radius, rings = 32, sectors = 64)
{
  const position = [], normal = [], uv = [], indices = [];
  for (let r = 0; r <= rings; r++)
  {
    const phi = r / rings * Math.PI;
    for (let s = 0; s <= sectors; s++)
    {
      const theta = s / sectors * Math.PI * 2;
      const n = [ Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta) ];
      position.push(n[0] * radius, n[1] * radius, n[2] * radius);
      normal.push(...n);
      uv.push(s / sectors, r / rings);
    }
  }
  for (let r = 0; r < rings; r++) for (let s = 0; s < sectors; s++)
  {
    const a = r * (sectors + 1) + s, b = a + sectors + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return Geometry("sphere", {
    decl: [
      { usage: "Position", usageIndex: 0, type: "Float32", elementCount: 3, offset: 0 },
      { usage: "Normal", usageIndex: 0, type: "Float32", elementCount: 3, offset: 12 },
      { usage: "TexCoord", usageIndex: 0, type: "Float32", elementCount: 2, offset: 24 }
    ],
    vertex: { position: new Float32Array(position), normal: new Float32Array(normal), texcoord0: new Float32Array(uv) },
    vertexCount: position.length / 3,
    indexBuffer: new Uint32Array(indices),
    areas: [ { name: "sphere", firstElement: 0, elementCount: indices.length / 3 } ],
    bounds: { min: [ -radius, -radius, -radius ], max: [ radius, radius, radius ] },
    boundingSphere: [ 0, 0, 0, radius ]
  });
}

// A unit quad in xy, -1..1: the shape every marker and particle instance is drawn with.
function QuadGeometry()
{
  return Geometry("quad", {
    decl: [ { usage: "Position", usageIndex: 0, type: "Float32", elementCount: 3, offset: 0 } ],
    vertex: { position: new Float32Array([ -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0 ]) },
    vertexCount: 4,
    indexBuffer: new Uint32Array([ 0, 1, 2, 0, 2, 3 ]),
    areas: [ { name: "quad", firstElement: 0, elementCount: 2 } ],
    bounds: { min: [ -1, -1, 0 ], max: [ 1, 1, 0 ] },
    boundingSphere: [ 0, 0, 0, 1.5 ]
  });
}

function PlanetCanvas()
{
  // A banded gas giant, drawn here: our own "procedural canvas" texture.
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const c = canvas.getContext("2d");
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < 512; y += 4)
  {
    const band = Math.sin(y * 0.045) * 0.5 + Math.sin(y * 0.11 + 1.3) * 0.3;
    c.fillStyle = `hsl(${28 + band * 22}, ${48 + band * 16}%, ${58 + band * 18}%)`;
    c.fillRect(0, y, 1024, 4);
  }
  for (let i = 0; i < 160; i++)
  {
    c.fillStyle = `hsla(${18 + random() * 30}, 55%, ${40 + random() * 40}%, 0.25)`;
    c.beginPath();
    c.ellipse(random() * 1024, random() * 512, 20 + random() * 90, 3 + random() * 9, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = "rgba(150, 52, 40, 0.8)";
  c.beginPath();
  c.ellipse(300, 330, 60, 26, 0, 0, Math.PI * 2);
  c.fill();
  return canvas;
}

function mesh(geometry, effect, batchType)
{
  const object = new Tr2Mesh();
  object.PySetGeometryRes(geometry);
  const area = new Tr2MeshArea();
  area.SetMaterial(effect);
  area.SetIndex(0);
  area.SetCount(1);
  object.AddArea(batchType, area);
  return object;
}

function instancedMesh(geometry, provider, effect, batchType)
{
  const object = new Tr2InstancedMesh();
  object.PySetGeometryRes(geometry);
  object.SetInstanceGeometryRes(provider);
  const area = new Tr2MeshArea();
  area.SetMaterial(effect);
  area.SetIndex(0);
  area.SetCount(1);
  object.AddArea(batchType, area);
  return object;
}

// Everything in the scene as one Trinity renderable: the render step asks for each batch type in turn.
class Scene extends ITr2Renderable
{
  parts = [];   // { name, batchType, commit(accumulator, batchType) }

  GetPerObjectData(_accumulator)
  {
    return null;
  }

  GetBatches(accumulator, batchType, _perObjectData, _reason)
  {
    let committed = false;
    for (const part of this.parts)
      if (part.batchType === batchType && shows(part.name)) committed = part.commit(accumulator, batchType) || committed;
    return committed;
  }

  HasTransparentBatches()
  {
    return true;
  }

  GetSortValue()
  {
    return 0;
  }
}

async function Main()
{
  const canvas = document.getElementById("view");
  const ratio = Number(params.get("ratio") ?? globalThis.devicePixelRatio ?? 1);
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));

  const { backend, renderContext } = await ShatteredBoot({
    canvas,
    res: new URL("./res/", location.href),
    preference: BACKEND ? [ BACKEND ] : [ "webgpu", "webgl2" ],
    effectPaths: { blit: "res:/graphics/effect/shattered/system/blit.fx", blitFiltered: "res:/graphics/effect/shattered/system/blitfiltered.fx" }
  });
  spike.backendName = backend.name;
  spike.adapter = backend.name;

  let loading = true;
  const pump = () => { if (!loading) return; PumpLoading(); requestAnimationFrame(pump); };
  requestAnimationFrame(pump);
  const [ planetEffect, markerEffect, lineEffect, particleEffect, blitEffect ] = await Promise.all(
    [ "scene/planet", "scene/marker", "scene/line", "scene/particle", "system/blitfiltered" ].map(LoadEffect));
  loading = false;

  const identity = { vs: RawData.create("SceneObjectVSData") };
  const scene = new Scene();
  const state = { time: 0 };
  const eye = vec3.create();

  // 1. A sphere with our own shader and our own texture.
  const PLANET_RADIUS = 2;
  const planetData = { vs: RawData.create("SceneObjectVSData") };
  const planetTransform = mat4.create();
  const planet = mesh(SphereGeometry(PLANET_RADIUS), planetEffect, TriBatchType.TRIBATCHTYPE_OPAQUE);
  planetEffect.SetParameter__TextureProvider("PlanetMap", CreateTextureFromImage(PlanetCanvas(), { name: "planet" }));
  scene.parts.push({ name: "planet", batchType: TriBatchType.TRIBATCHTYPE_OPAQUE, commit: (accumulator, type) => planet.GetBatches(accumulator, type, planetData) });

  // 2. Instancing: MARKERS small quads in one draw. Each row of the stream is one instance.
  const quad = QuadGeometry();
  const markerData = new Tr2RuntimeInstanceData();
  markerData.SetElementLayout([
    { usage: "TEXCOORD", usageIndex: 0, type: "FLOAT32_4", name: "placement" },   // TEXCOORD8 in the effect
    { usage: "TEXCOORD", usageIndex: 1, type: "FLOAT32_4", name: "colour" }       // TEXCOORD9
  ]);
  const markerHome = [];
  for (let i = 0; i < MARKERS; i++)
  {
    // A ring of debris round the planet, plus scatter.
    const angle = i / MARKERS * Math.PI * 2 * 5.03, radius = 3.2 + (i % 17) / 17 * 2.6;
    markerHome.push([ Math.cos(angle) * radius, Math.sin(i * 12.9898) * 0.35, Math.sin(angle) * radius, 0.035 + (i % 5) * 0.012 ]);
  }
  const markerRows = time => markerHome.map((home, i) =>
  {
    const turn = time * 0.15 / Math.sqrt(Math.hypot(home[0], home[2]));
    const c = Math.cos(turn), s = Math.sin(turn);
    return [ [ home[0] * c - home[2] * s, home[1], home[0] * s + home[2] * c, home[3] ],
      i % 9 === 0 ? [ 0.89, 0.36, 0.23, 0.95 ] : [ 0.95, 0.92, 0.80, 0.75 ] ];
  });
  markerData.SetData(markerRows(0));
  markerData.SetBoundingBox([ -6, -1, -6 ], [ 6, 1, 6 ]);
  markerData.UpdateData();
  const markers = instancedMesh(quad, markerData, markerEffect, TriBatchType.TRIBATCHTYPE_TRANSPARENT);
  scene.parts.push({ name: "markers", batchType: TriBatchType.TRIBATCHTYPE_TRANSPARENT, commit: (accumulator, type) => markers.GetBatches(accumulator, type, identity) });

  // 3. Lines and curves: the engine's curve-line set, our effect. Widths are in pixels in our shader.
  const lines = new Tr2CurveLineSet();
  lines.SetLineEffect(lineEffect);
  lines.SetAdditiveFlag(true);
  const gold = [ 1, 0.82, 0.45, 1 ], blue4 = [ 0.45, 0.7, 1, 1 ], red = [ 1, 0.35, 0.25, 1 ];
  lines.AddStraightLine([ -6, 2.2, -1 ], red, [ 6, 2.6, 1 ], gold, 2.5);                              // a weapon beam
  const LANE = [ [ -5.5, -1.5, 2 ], [ 5.5, -1.2, 2.5 ], [ 0, -3.4, 4.5 ] ];   // start, end, control point
  lines.AddCurvedLineCrt(LANE[0], blue4, LANE[1], blue4, LANE[2], 2, 32);                                 // a lane
  lines.AddSpheredLineCrt([ 2.6, 0, 0 ], gold, [ 0, 0, 2.6 ], red, [ 0, 0, 0 ], 3);                   // an arc round the planet
  lines.SubmitChanges();
  scene.parts.push({ name: "lines", batchType: TriBatchType.TRIBATCHTYPE_ADDITIVE, commit: (accumulator, type) => { lines.GetBatches(accumulator, type, identity); return true; } });

  // 4. Particles: the engine's CPU particle system and emitter, our effect. An engine exhaust.
  const particles = new Tr2ParticleSystem();
  particles.maxParticleCount = 600;
  for (const elementType of [ Tr2ParticleElementDeclaration.Type.LIFETIME, Tr2ParticleElementDeclaration.Type.POSITION, Tr2ParticleElementDeclaration.Type.VELOCITY ])
    particles.elements.push(Object.assign(new Tr2ParticleElementDeclaration(), { elementType }));
  particles.Initialize();
  const emitter = new Tr2DynamicEmitter();
  emitter.particleSystem = particles;
  emitter.rate = 180;   // particles a second
  const shape = new Tr2SphereShapeAttributeGenerator();
  Object.assign(shape, { minRadius: 0, maxRadius: 0.08, minSpeed: 0.9, maxSpeed: 1.6, minPhi: 0, maxPhi: 28, minTheta: 0, maxTheta: 360 });
  vec3.set(shape.position, -3.6, 1.1, 2.2);
  const lifetime = new Tr2RandomUniformAttributeGenerator();
  lifetime.elementType = Tr2ParticleElementDeclaration.Type.LIFETIME;
  lifetime.minRange.set([ 0, 0.9, 0, 0 ]);
  lifetime.maxRange.set([ 0, 1.6, 0, 0 ]);
  emitter.generators.push(shape);
  emitter.generators.push(lifetime);
  emitter.Initialize();
  if (!emitter.isValid && !emitter.Rebind()) throw new Error("the particle emitter did not bind to the system's elements");
  // Two seconds of exhaust before the first frame, so every shot shows a full plume.
  for (let i = 0; i < 120; i++)
  {
    emitter.UpdateSimulation(1 / 60);
    particles.UpdateSimulation(1 / 60);
  }
  const particleTransform = mat4.create();
  const exhaust = instancedMesh(quad, particles, particleEffect, TriBatchType.TRIBATCHTYPE_ADDITIVE);
  scene.parts.push({ name: "particles", batchType: TriBatchType.TRIBATCHTYPE_ADDITIVE, commit: (accumulator, type) => exhaust.GetBatches(accumulator, type, identity) });

  // Targets: colour and depth offscreen (the canvas has no depth buffer of ours), then a blit.
  const colourTarget = new Tr2RenderTarget();
  const depth = new Tr2DepthStencil();
  colourTarget.Create(canvas.width, canvas.height, 1, PixelFormat.PIXEL_FORMAT_R8G8B8A8_UNORM);
  depth.Create(canvas.width, canvas.height, DepthStencilFormat.DSFMT_D32F, 1, 0, 0, renderContext);
  if (!colourTarget.IsValid() || !depth.IsValid()) throw new Error("the scene targets could not be created");

  // 7. Cameras. Ours: orbit maths on TriView / TriProjection. The engine's: EveCamera, an orbit camera
  // with its own view and projection objects, updated by hand (no scene driver).
  const view = new TriView();
  const projection = new TriProjection();
  const orbit = new EveCamera();
  orbit.fieldOfView = 0.75;
  orbit.frontClip = 0.1;
  orbit.backClip = 200;
  orbit.translationFromParent = 13;
  orbit.idleMove = false;
  // Its default zoom curve animates fieldOfView toward the curve's first key (a wide EVE lens); without a
  // curve the field of view set here holds.
  orbit.zoomCurve = null;
  const frameVS = RawData.create("ScenePerFrameVSData"), framePS = RawData.create("ScenePerFramePSData");
  const frameVSBuffer = new Tr2ConstantBufferAL(), framePSBuffer = new Tr2ConstantBufferAL();
  const viewProjection = mat4.create(), viewMatrix = mat4.create(), projectionMatrix = mat4.create(), inverseView = mat4.create();

  const esm = () => renderContext.GetEffectStateManager();
  const callback = fn => { const step = new TriStepPythonCB(); step.callback = BlueScriptCallback.from(fn); return step; };
  const clear = new TriStepClear();
  clear.color.set([ 0.043, 0.051, 0.094, 1 ]);
  clear.depth = 1;
  clear.isColorCleared = clear.isDepthCleared = true;
  const setView = new TriStepSetView();
  const setProjection = new TriStepSetProjection();
  const draw = flags =>
  {
    const step = new TriStepRenderObject();
    step.renderable = scene;
    step.renderDecal = false;
    step.renderOpaque = !!flags.opaque;
    step.renderTransparent = !!flags.transparent;
    step.renderAdditive = !!flags.additive;
    return step;
  };
  const present = new TriStepRenderEffect();
  present.effect = blitEffect;

  const job = new TriRenderJob();
  job.name = "ShatteredScene";
  for (const step of [
    callback(() =>
    {
      const aspect = canvas.width / canvas.height;
      if (CAMERA === "eve")
      {
        orbit.SetOrbit(state.time * 0.2 + 0.6, 0.32);
        // Update takes Blue time (ticks, CcpTime), not seconds.
        orbit.Update(CcpTime.timeFromDouble(state.time), aspect);
        setView.view = orbit.viewMatrix;
        setProjection.projection = orbit.projectionMatrix;
      }
      else if (CAMERA === "chase")
      {
        // A ship flies the lane: the same Hermite curve the line set draws for AddCurvedLineCrt (tangents
        // middle - start and end - middle). The camera sits behind and above where the ship was a moment
        // ago, and looks at it.
        const lane = t =>
        {
          const t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
          return [ 0, 1, 2 ].map(k => h00 * LANE[0][k] + h10 * (LANE[2][k] - LANE[0][k]) + h01 * LANE[1][k] + h11 * (LANE[1][k] - LANE[2][k]));
        };
        const t = (state.time * 0.08) % 1, ship = lane(t), behind = lane(Math.max(0, t - 0.06));
        const back = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), behind, ship));
        vec3.set(eye, ship[0] + back[0] * 3.5, ship[1] + 1.4, ship[2] + back[2] * 3.5);
        view.SetLookAtPosition(eye, ship, [ 0, 1, 0 ]);
        projection.PerspectiveFov(0.9, aspect, 0.05, 200);
        setView.view = view;
        setProjection.projection = projection;
      }
      else if (CAMERA === "free")
      {
        // A position and a heading (yaw, pitch), moved straight ahead: a fly-past of the planet.
        const yaw = -0.35 + state.time * 0.03, pitch = -0.12;
        const forward = [ Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch) ];
        vec3.set(eye, -2.5 + forward[0] * state.time * 0.6, 1.6 + forward[1] * state.time * 0.6, 11 + forward[2] * state.time * 0.6);
        view.SetLookAtPosition(eye, vec3.add(vec3.create(), eye, forward), [ 0, 1, 0 ]);
        projection.PerspectiveFov(0.8, aspect, 0.05, 200);
        setView.view = view;
        setProjection.projection = projection;
      }
      else
      {
        const yaw = state.time * 0.2 + 0.6, pitch = 0.32, distance = 13;
        vec3.set(eye, Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance);
        view.SetLookAtPosition(eye, [ 0, 0, 0 ], [ 0, 1, 0 ]);
        projection.PerspectiveFov(0.75, aspect, 0.1, 200);
        setView.view = view;
        setProjection.projection = projection;
      }
      // Simulation: the planet turns, the markers orbit, the exhaust emits and ages.
      mat4.fromYRotation(planetTransform, state.time * 0.1);
      planetData.vs.SetAndTranspose("worldTransform", planetTransform);
      if (state.dt > 0)
      {
        markerData.SetData(markerRows(state.time));
        markerData.UpdateData();
        emitter.UpdateSimulation(state.dt);
        particles.UpdateSimulation(state.dt);
      }
      // What a scene driver would do for the system each frame: note its transform (this also prepares its
      // device buffer on first use), then sort and upload the live particles. Without these two calls the
      // system simulates but draws nothing.
      particles.UpdateViewDependentData(null, particleTransform);
      particles.SortParticles();
      esm().SetRenderTarget(0, colourTarget.GetRenderTarget());
      esm().SetDepthStencilBuffer(depth.GetDepthStencil());
      esm().SetFullScreenViewport();
    }),
    clear,
    setView,
    setProjection,
    callback(() =>
    {
      mat4.copy(viewMatrix, Tr2Renderer.GetViewTransform());
      mat4.copy(projectionMatrix, Tr2Renderer.GetProjectionTransform());
      mat4.multiply(viewProjection, projectionMatrix, viewMatrix);
      mat4.invert(inverseView, viewMatrix);
      frameVS.SetAndTranspose("ViewProjectionMat", viewProjection);
      frameVS.Set("CameraRight", [ inverseView[0], inverseView[1], inverseView[2], 0 ]);
      frameVS.Set("CameraUp", [ inverseView[4], inverseView[5], inverseView[6], 0 ]);
      frameVS.Set("Viewport", [ canvas.width, canvas.height, state.time, 0 ]);
      const light = vec3.normalize(vec3.create(), [ -0.5, 0.45, 0.74 ]);
      framePS.Set("LightDirection", [ light[0], light[1], light[2], 0 ]);
      framePS.Set("Time", [ state.time, 0, 0, 0 ]);
      const vs = frameVS.GetData(), ps = framePS.GetData();
      Tr2RenderUtils.fillAndSetConstants(frameVSBuffer, vs, vs.byteLength, 1 << ShaderType.VERTEX_SHADER, PER_FRAME_VS, renderContext);
      Tr2RenderUtils.fillAndSetConstants(framePSBuffer, ps, ps.byteLength, 1 << ShaderType.PIXEL_SHADER, PER_FRAME_PS, renderContext);
    }),
    // 5. Three kinds of pass, each with the blend and depth state its effects declare.
    draw({ opaque: true }),
    draw({ transparent: true }),
    draw({ additive: true }),
    callback(() =>
    {
      backend.al.SetRenderTarget(0, GetCanvasTarget(backend));
      backend.al.SetDepthStencil(null);
      esm().SetFullScreenViewport();
      blitEffect.SetParameter__TextureAL("BlitSource", colourTarget.GetRenderTarget());
    }),
    present
  ]) job.steps.push(step);

  // 6. Picking: the engine turns a pixel into a world ray (screenToProjection, convertProjectionCoordToWorldPickRay)
  // and its ray maths (ray3) intersect it with spheres; which objects are pickable, and their radii, are ours.
  // Here: the planet's sphere, then the nearest marker within 1.5 times its half-size of the ray.
  const pickRay = ray3.create(), hit = vec3.create();
  const Pick = (x, y) =>
  {
    const point = screenToProjection(x, y, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    const ray = convertProjectionCoordToWorldPickRay(point.x, point.y, projectionMatrix, viewMatrix);
    if (!ray) return null;
    ray3.from(pickRay, ray.start, ray.direction);
    let best = null;
    if (ray3.getIntersectPositionRadius(hit, pickRay, [ 0, 0, 0 ], PLANET_RADIUS)) best = { what: "planet", distance: vec3.distance(hit, ray.start) };
    markerRows(state.time).forEach(([ placement ], index) =>
    {
      if (!ray3.getIntersectPositionRadius(hit, pickRay, placement, placement[3] * 1.5)) return;
      const distance = vec3.distance(hit, ray.start);
      if (!best || distance < best.distance) best = { what: "marker", index, distance };
    });
    return best ? { ...best, distance: +best.distance.toFixed(3) } : { what: "nothing" };
  };
  // Where a world point lands on the canvas, for the test and for HTML markers over the canvas.
  const Project = world =>
  {
    const x = viewProjection[0] * world[0] + viewProjection[4] * world[1] + viewProjection[8] * world[2] + viewProjection[12];
    const y = viewProjection[1] * world[0] + viewProjection[5] * world[1] + viewProjection[9] * world[2] + viewProjection[13];
    const w = viewProjection[3] * world[0] + viewProjection[7] * world[1] + viewProjection[11] * world[2] + viewProjection[15];
    return [ (x / w * 0.5 + 0.5) * (canvas.width - 1), (1 - (y / w * 0.5 + 0.5)) * (canvas.height - 1) ];
  };

  let pendingRead = null, last = performance.now();
  const cpu = [];   // CPU time of the last 60 DrawNow calls (simulation, uploads and draw recording), ms
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const tick = now =>
  {
    requestAnimationFrame(tick);
    state.dt = HOLD ? (state.step ?? 0) : Math.min(0.1, (now - last) / 1000);
    state.step = 0;
    last = now;
    if (!HOLD) state.time += state.dt;
    PumpLoading();
    const started = performance.now();
    DrawNow(job);
    cpu.push(performance.now() - started);
    if (cpu.length > 60) cpu.shift();
    spike.frames++;
    if (spike.firstFrameMs === null) spike.firstFrameMs = performance.now() - T0;
    spike.scene = { markers: markerData.GetCount(), lineSegments: lines.currentSubmittedLineCount, particlesAlive: particles.aliveCount, camera: CAMERA, jobStatus: job.status,
      cpuMsMean: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(2), cpuMsMax: +Math.max(...cpu).toFixed(2) };
    if (pendingRead)
    {
      const resolve = pendingRead;
      pendingRead = null;
      probe.canvas.width = canvas.width;
      probe.canvas.height = canvas.height;
      probe.drawImage(canvas, 0, 0);
      const data = probe.getImageData(0, 0, canvas.width, canvas.height).data;
      const colours = new Set();
      let lit = 0;
      for (let i = 0; i < data.length; i += 28)
      {
        colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (data[i] + data[i + 1] + data[i + 2] > 120) lit++;
      }
      const at = (x, y) => { const o = (Math.round(y) * canvas.width + Math.round(x)) * 4; return [ data[o], data[o + 1], data[o + 2], data[o + 3] ]; };
      const centre = Project([ 0, 0, 0 ]);
      resolve({ width: canvas.width, height: canvas.height, distinctColours: colours.size, litShare: +(lit / Math.ceil(data.length / 28)).toFixed(4),
        corner: at(4, 4), planetCentre: at(centre[0], centre[1]),
        picks: { planetCentre: Pick(centre[0], centre[1]), corner: Pick(4, 4), marker0: Pick(...Project(markerRows(state.time)[0][0])) } });
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
    ready: true, state, canvas, job, renderContext, backend, pick: Pick, project: Project,
    parts: { planet, markers, markerData, lines, particles, emitter, exhaust, scene },
    readCanvas: () => new Promise(resolve => { pendingRead = resolve; }),
    setYaw() {},
    setTime(seconds) { state.step = Math.max(0, seconds - state.time); state.time = seconds; },
    status: () => job.status,
    debug: () =>
    {
      if (!spike.trace)
      {
        spike.trace = [];
        const getBatches = exhaust.GetBatches.bind(exhaust);
        exhaust.GetBatches = (accumulator, type, data) =>
        {
          const result = getBatches(accumulator, type, data);
          if (spike.trace.length < 40) spike.trace.push({ exhaust: result, type, alive: particles.aliveCount, ready: particles.IsInstanceDataReady(), good: exhaust.GetGeometryResource()?.IsGood(), accepted: accumulator.constructor.name });
          return result;
        };
        const submit = renderContext.SubmitGeometry.bind(renderContext);
        renderContext.SubmitGeometry = batch =>
        {
          const result = submit(batch);
          if (spike.trace.length < 40) spike.trace.push({ effect: batch.material?.effectFilePath, instances: batch.instanceCount, indices: batch.indexCountPerInstance,
            streams: batch.vertexStreams.map(s => !!s), stride: Array.from(batch.stride ?? []), decl: batch.vertexDeclaration, result });
          return result;
        };
      }
      const position = [], life = [];
      for (let i = 0; i < Math.min(4, particles.aliveCount); i++)
      {
        position.push(Array.from(particles.GetParticleElement(i, Tr2ParticleElementDeclaration.Type.POSITION) ?? []).map(v => +v.toFixed(3)));
        life.push(Array.from(particles.GetParticleElement(i, Tr2ParticleElementDeclaration.Type.LIFETIME) ?? []).map(v => +v.toFixed(3)));
      }
      const instance = particles.GetInstanceData();
      return { alive: particles.aliveCount, position, life, stride: instance.stride, buffer: !!instance.buffer, ready: particles.IsInstanceDataReady(),
        declaration: exhaust._vertexDeclaration, batch: (() => { const list = []; exhaust.GetBatches({ Commit: b => (list.push(b.constructor.name), true) }, TriBatchType.TRIBATCHTYPE_ADDITIVE, identity); return list; })(),
        projected: position.map(p => Project(p)),
        particleDecl: JSON.parse(JSON.stringify(Tr2EffectStateManager.getVertexDeclarationElements(exhaust._vertexDeclaration))),
        markerDecl: JSON.parse(JSON.stringify(Tr2EffectStateManager.getVertexDeclarationElements(markers._vertexDeclaration))) };
    }
  });
}

Main().catch(error =>
{
  spike.error = String(error?.stack ?? error);
  console.error("scene failed", error);
  document.getElementById("status").textContent = spike.error;
});
