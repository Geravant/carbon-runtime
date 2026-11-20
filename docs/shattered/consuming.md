# The slim runtime for Shattered Reach: building and consuming it

`@geravant/carbon-runtime-slim` is a build of our fork of CarbonEngineJS (`Geravant/carbon-runtime`, branch `shattered/main`) holding only what a game with its own content needs: the device layers (WebGPU; WebGL2 loaded on demand), Trinity core, render jobs and steps, the effect loader, geometry intake, Blue's services, maths and input. It holds no EVE scene classes, ship assembly (SOF), character or audio code, and it loads no EVE content.

The engine's source uses decorators, so it cannot be used as a plain git dependency: it has to be built. The game depends on a packed tarball, pinned to a commit of the fork.

## Build and pack (in the fork)

```sh
npm ci
node shattered/scripts/pack.mjs
```

This builds `shattered/dist/` and writes `shattered/pack/geravant-carbon-runtime-slim-<version>.tgz`. `<version>` is the engine's version followed by `.sr.g<commit>`, for example `0.1.0-alpha.14.sr.g45319052e`. `shattered/pack/latest.json` names the newest tarball, its commit and its integrity hash. The script refuses to pack uncommitted changes to tracked files unless given `--allow-dirty`.

`node shattered/scripts/build-slim.mjs` alone rebuilds `shattered/dist/` (about a second once its cache is warm) and prints the minified sizes. The full `npm run build:npm` is not needed.

## Consume (in the game)

Copy the tarball into the game repository and depend on the file, so the test server and other machines need no access to the fork:

```sh
cp <fork>/shattered/pack/geravant-carbon-runtime-slim-<version>.tgz vendor/
npm install ./vendor/geravant-carbon-runtime-slim-<version>.tgz
```

`package.json` then holds `"@geravant/carbon-runtime-slim": "file:vendor/geravant-carbon-runtime-slim-<version>.tgz"`, and the lock file holds its integrity hash. To move to a newer engine, pack again, replace the file and reinstall; delete the old tarball.

**In a Docker image the tarball has to be there before the install.** A `file:` dependency is read by `npm ci` / `npm install`, so a Dockerfile that copies `package.json` and the lock file first and the rest later fails with a missing-file error. Copy `vendor/` in the same step:

```dockerfile
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci
```

The package is one ES module with lazy chunks and no dependencies. Vite 6 bundles it as it is (checked: a `vite build` of the spike page over the tarball runs on both backends; the main chunk is 3,162 KB raw, 710 KB gzip). The package's files are not minified; the game's production build minifies them. Vite prints one warning, that `new URL("./CjsResManWorker.js", import.meta.url)` does not exist at build time: that is the engine's optional resource-loading worker, which `ShatteredBoot` does not start.

```js
import { ShatteredBoot, RawData, TriGeometryRes, Tr2Effect, blue } from "@geravant/carbon-runtime-slim";
```

### Start-up

```js
const { backend, device, renderContext, effectTarget } = await ShatteredBoot({
  canvas,                                   // already sized in device pixels
  res: new URL("./res/", location.href),    // where res:/ resolves
  preference: [ "webgpu", "webgl2" ],       // default
  effectPaths: {                            // our files for the two effects the engine itself creates
    blit: "res:/graphics/effect/shattered/system/blit.fx",
    blitFiltered: "res:/graphics/effect/shattered/system/blitfiltered.fx"
  }
});
```

`ShatteredBoot` starts the engine with no DXBC translator, no SOF, character or audio service and no callback workers. `backend.name` is `"webgpu"` or `"webgl2"`; `effectTarget` is the effect tree in use, `"webgpu"` or `"webgl"`.

Blue is pumped by the host: resources finish loading, and render jobs run, only inside `blue.os.PumpOS()`. Call it every animation frame, from before the first `await blue.resMan.Ready(...)`.

### Drawing and pumping: three calls

```js
import { blue, DrawNow, PumpLoading, GetCanvasTarget } from "@geravant/carbon-runtime-slim";
```

| Call | Loading pumped | Render jobs | Use |
|---|---|---|---|
| `blue.os.PumpOS()` | yes | every job installed on the device, **exactly once per call** | the plain one-view loop |
| `DrawNow(job)` | no | **that job, exactly once**, before the call returns; the job need not be registered | several views a frame: one call per view |
| `DrawNow()` | no | every installed job, exactly once | |
| `PumpLoading()` | yes | none | once per animation frame beside `DrawNow`; and while awaiting a load when the installed jobs must not run |

- The once-per-call promise: `PumpOS` calls each Blue ticker once, the device's tick calls `Render` once, `Render` runs `Tr2RenderJobs.Run` once, and no step of that is gated on time or frame rate. `DrawNow` calls `device.Render()` directly. Any of them may be called many times in one task. The spike page checks it on both backends: `?views=6` draws six views a frame with six `DrawNow(job)` calls (`&draw=pump`: six `PumpOS()` calls) and counts six job runs every frame (`shots/m3/views/`).
- Each `DrawNow` or `PumpOS` is a complete device frame. Several in one task accumulate on the canvas: a later call does not clear what an earlier one drew, unless a `TriStepClear` runs with the canvas bound.
- A job with `job.enabled = false` is skipped by all of them. That is the per-job switch.
- `PumpLoading()` leaves the canvas showing its last picture (checked: `?lateload=1` loads a PNG through `resMan` under `PumpLoading()` only; the registered job ran 0 times and the page still showed the ship).
- With `DrawNow` the engine's animation clock (`device.animationTime`) only moves in `PumpLoading()`/`PumpOS()`; pass your own time to your shaders.

**The canvas as a target, on both backends:** `backend.GetCanvasTarget()` (or `GetCanvasTarget(backend)`).

```js
backend.al.SetRenderTarget(0, backend.GetCanvasTarget());
backend.al.SetDepthStencil(null);
renderContext.GetEffectStateManager().SetViewport({ x, y, width, height });   // canvas pixels, origin top left
```

(Bind it through `renderContext.GetEffectStateManager().SetRenderTarget(0, ...)` instead when an earlier step bound a target of another size: see "Render targets as a view's output, at any size".) A viewport set this way on the canvas is honoured to the pixel on WebGPU and WebGL2: in the six-view test no pixel of a view lies outside its rectangle and no gutter pixel inside one, with the same edge pixels on both backends. `TriStepClear` clears the whole bound target, not the viewport: clear before setting a view's rectangle. In a full-screen effect `SV_Position` is in target pixels, so subtract the viewport origin when a view's offscreen targets start at (0, 0) (`ViewRect` in the spike's `watercolour.fx`).

### Fork additions the game should use

| Call | Replaces |
|---|---|
| `geometry.PrepareFromCmfData({ meshes: [...] })` on a `TriGeometryRes` | `SetupMeshes__CmfData` plus setting `_useCMF`, `_isPrepared` and `_isGood` by hand. Returns `true` when the resource is good. |
| `RawData.RegisterLayouts(groups, owner)` then `RawData.create("StructName")` | building layouts with `CjsConstantLayout.BuildLayouts` and calling the `RawData` constructor |
| `SetBuiltInEffectPaths({ blit, blitFiltered })` or the `effectPaths` option | serving our files at the engine's `managed/space/system/` paths |
| `AcquireBackend({ ..., translator: false })` (done by `ShatteredBoot`) | passing an `effects` section by hand |
| `Tr2DepthStencil.Create` now throws a `RangeError` for a format no backend can create | an invalid surface with no message |
| `backend.GetCanvasTarget()` | `backend.name === "webgpu" ? backend.renderTarget : backend.al.GetDefaultBackBuffer()` |
| `DrawNow(job)`, `PumpLoading()` | calling `PumpOS()` per view with guards in every job callback |
| `LoadTexture`, `CreateTextureFromImage`, `UpdateTextureFromImage` | nothing: textures were not loadable before |
| `UpdateTextureFromImage(t, src, { rect })`, `CreateTextureFromData`, `UpdateTextureFromData`, `LoadTexture(url, { maxSize })`, `ReleaseTexture` | whole-texture repaints; uniform arrays for data; oversized pictures |
| `ReleaseGeometry(geometry)`, `GeometryPoolStats()` | dropping references, which frees nothing |
| `ReleaseRenderTarget(target)` | `target.ReleaseResources()` with no argument, which does nothing |
| `InstanceStream` | padding instance rows to keep the allocation |
| `CurveLineSpans` | one ribbon mesh per clipped course |
| `TimeJob(job)`, `TimeJobNow(job)`, `ShatteredBoot({ gpuTimer: true })` | submit-to-done times |
| `OrbitCamera` | `EveCamera` with `zoomCurve = null` (still clamped above aspect 1.6) |

### Textures (our own images)

PNG, JPEG, WebP or anything else the browser decodes, from a URL or from memory, on both backends:

```js
import { LoadTexture, CreateTextureFromImage, UpdateTextureFromImage } from "@geravant/carbon-runtime-slim";

const backdrop = await LoadTexture("res:/textures/backdrop.jpg");          // or any URL the page may fetch
const drawn = CreateTextureFromImage(canvas);                              // canvas, OffscreenCanvas, ImageBitmap, ImageData, <img>
UpdateTextureFromImage(drawn, canvas);                                     // after redrawing the canvas (same size)
effect.SetParameter__TextureProvider("BackdropMap", backdrop);             // the Texture2D's name in the .fx
```

- Both calls return a `TriTextureRes` that is already good (`GetWidth()`, `GetHeight()`, `GetTexture()`). Call them after `ShatteredBoot`; they need no `PumpOS` and may be called between frames or inside a job.
- The browser decodes (`createImageBitmap`) and the pixels go to the GPU through the layer's external-image upload; nothing is decoded in JS.
- The texture is RGBA8 holding the file's bytes: sRGB-encoded values as painted, straight (not premultiplied) alpha, row 0 at `v = 0`. A shader that writes them to the canvas unchanged shows the picture as painted.
- `{ mips: true }` (the default) builds the full mip chain, so `MIN_MAG_MIP_LINEAR` is trilinear. Pass `{ mips: false }` for pictures always drawn 1:1.
- To free one: `ReleaseTexture(texture)`.

In the effect, declare the texture and a sampler and call `Sample`:

```hlsl
Texture2D BackdropMap;
SamplerState LinearClamp { Filter = MIN_MAG_MIP_LINEAR; AddressU = CLAMP; AddressV = CLAMP; };
float4 colour = BackdropMap.Sample( LinearClamp, uv );
```

Filter (`MIN_MAG_MIP_LINEAR`, `MIN_MAG_MIP_POINT`) and addressing (`CLAMP`, `WRAP`) behave the same on WebGPU and WebGL2 (measured on the spike page: `shots/m3/textures/`). Two rules that differ from plain HLSL:

- **One sampler state per texture name on WebGL2.** GLSL joins a texture and its sampler, and the WebGL2 effect compiler emits one `sampler2D` per `Texture2D`: the first sampler used with it wins, silently. To read one texture both point-sampled and filtered, declare a second `Texture2D` name and bind the same texture to both (`effects/backdrop.fx` does). WebGPU honours every pair as written, so a mistake here shows only on WebGL2.
- **`Sample` outside branches.** A `Sample` (implicit derivatives) inside an `if` or after an early return fails WGSL validation; sample first, then choose, or use `SampleLevel`.

The engine's own route works too: `blue.resMan.GetResource("res:/textures/marker.png")`, `await blue.resMan.Ready(resource)` (while `PumpOS` is being called), or a path in a `TriTextureParameter` / `effect.SetResourceTexture2D(name, path)`. `.png`, `.jpg` and `.jpeg` are registered. That route decodes with the engine's JS readers on the main thread and makes a texture with no mips, so use it for small images and `LoadTexture` for backdrops.

### Several colour targets in one pass

Works on both backends with no engine change. Bind the second target to slot 1, draw with an effect whose pixel shader returns a struct of `SV_Target0` and `SV_Target1`, and let slot 1 go afterwards:

```js
const esm = renderContext.GetEffectStateManager();
esm.SetRenderTarget(0, colourTarget.GetRenderTarget());
esm.SetRenderTarget(1, normalTarget.GetRenderTarget());
esm.SetDepthStencilBuffer(depth.GetDepthStencil());
// ... TriStepClear (clears every bound colour target and the depth), view, projection, draw ...
esm.SetRenderTarget(1, null);          // before the next pass binds its own target
```

```hlsl
struct HullTargets { float4 colour : SV_Target0; float4 normal : SV_Target1; };
HullTargets HullMrtPS( HullVSOutput input ) { HullTargets output; /* ... */ return output; }
```

The spike page does this under `?mrt=1` (`effects/hullmrt.fx`): the picture is identical, pixel for pixel, to the two-pass one on WebGPU and on WebGL2, and the two backends' pictures are identical to each other (`shots/m3/mrt/`, compared with `tools/diff.mjs`). 30 ships: 31 draws a frame instead of 61. Not tested: targets of different sizes or formats (the spike's are both RGBA16F at the canvas's size), and more than two targets.

### Scene building blocks: instancing, lines, particles, picking, cameras

All tried on both backends on the capability page `examples/shattered-spike/scene.html` (`src/scene.js`, effects in `effects/scene/`); the ratings and the reasons are in `07-scene-capabilities.md` in the port docs. What a consumer must know:

- **Untextured effects draw now.** The engine's effect-sorted accumulators (opaque, decal, additive) used to set aside every indexed triangle batch whose effect binds no texture as a "GPU-driven" batch, and nothing in this runtime draws those: the batch vanished with no error. `ShatteredBoot` turns that split off (`EffectKeyGenerator.ALLOW_GDPR = false`), so every batch is drawn, effect-sorted as before. A host that boots some other way must set it itself.
- **Instancing:** `Tr2InstancedMesh` over `Tr2RuntimeInstanceData` (`SetElementLayout`, `SetData(rows)`, `UpdateData()` each time the rows change). Instance elements reach the vertex shader with their usage index raised by 8: the stream's `TEXCOORD0` is `TEXCOORD8` in the effect.
- **Lines:** `Tr2CurveLineSet` with our own effect (`SetLineEffect`); `AddStraightLine`, `AddCurvedLineCrt` (a Hermite curve), `AddSpheredLineCrt`, then `SubmitChanges()`. The vertex layout our effect must read is in `effects/scene/line.fx`. Its batches go to the additive list when `SetAdditiveFlag(true)`, else transparent.
- **Particles (CPU):** `Tr2ParticleSystem`, `Tr2DynamicEmitter`, the attribute generators, forces and constraints are exported. Draw the system as the instance stream of a `Tr2InstancedMesh` over a quad. Each frame, after `emitter.UpdateSimulation(dt)` and `system.UpdateSimulation(dt)`, call `system.UpdateViewDependentData(null, worldMatrix)` and `system.SortParticles()`: that is what a scene driver did, and without it the system simulates but uploads nothing. Elements arrive as `POSITION8`/`POSITION9` (now, previous), `TANGENT8` (lifetime: x age 0..1, y seconds), `NORMAL8` (velocity). The GPU particle systems are not exported.
- **Picking:** `screenToProjection` and `convertProjectionCoordToWorldPickRay` give a world ray from a pixel; `ray3` (`from`, `getIntersectPositionRadius`, `getIntersectBox3`, `getIntersectTri3`) intersects it. Which objects can be picked is the host's.
- **Cameras:** `EveCamera` (an orbit camera with its own `TriView` and `TriProjection`) is exported; set `zoomCurve = null` or its default curve overrides `fieldOfView`, and pass `Update` Blue time (`CcpTime.timeFromDouble(seconds)`), not seconds. Chase and free cameras are a few lines on `TriView.SetLookAtPosition` and `TriProjection.PerspectiveFov` (the page has both).

### Washes inside the scene's colour target

A transparent pass can blend into the offscreen colour target that a full-screen paper pass reads afterwards. It works on both backends with no engine change. Draw the strokes after the opaque pass, with the colour target still bound, through a `TriStepRenderObject` with `renderTransparent = true`. Each stroke's effect blends colour by its strength and alpha "over" alpha:

```hlsl
AlphaBlendEnable = true;  SrcBlend = SRCALPHA;  DestBlend = INVSRCALPHA;  BlendOp = ADD;
SeparateAlphaBlendEnable = true;  SrcBlendAlpha = ONE;  DestBlendAlpha = INVSRCALPHA;  BlendOpAlpha = ADD;
```

A wash of strength `a` over what is there leaves colour `rgb·a + dst·(1−a)` and strength `a + dstA·(1−a)`. Two washes, or a wash over the territory, make a stronger stroke for the paper pass, never a paler one. The transparent list keeps the order the batches were committed in. On the proof page (`requests.html`, `effects/req/wash.fx`, an RGBA16F target) every measured paper pixel matches the over operator exactly, on WebGPU and WebGL2. Beside it, the same washes written opaquely show the pale hole: the later stroke replaces the strength and the territory under it. If the paper pass needs a different meaning in alpha (a kind flag, for example), change the alpha factors. `BLENDOPALPHA = MAX` keeps the strongest stroke.

A pass's own `AlphaBlendEnable = false` holds after an additive `TriStepRenderObject`. On the proof page an additive step runs right before two paper passes in a row, and the picture does not change.

### Textures: parts, data, size caps, release

```js
import { UpdateTextureFromImage, CreateTextureFromData, UpdateTextureFromData, ToHalfFloat, LoadTexture, ReleaseTexture } from "@geravant/carbon-runtime-slim";

UpdateTextureFromImage(field, canvas, { rect: { x, y, width, height } });     // only that part, read from the same part of the canvas
UpdateTextureFromImage(field, imageData, { x: 16, y: 16 });                  // a smaller picture written at 16,16
const marks = CreateTextureFromData(new Float32Array(w * h * 4), w, h, { format: "rgba32f" });   // also rg32f, r32f, rgba16f, r16f, rgba8
UpdateTextureFromData(marks, rowData, { x: 0, y: 3, width: w, height: 1 }); // one row
const painting = await LoadTexture("res:/textures/backdrop.webp", { maxSize: 2048 });            // longer side capped, mips from the scaled picture
ReleaseTexture(painting);                                                   // frees it now
```

- `rect` and `x`/`y` use the layers' typed-array upload, which takes an offset on both backends. An `ImageData` is read directly. Any other source is read back through a 2D canvas the size of the part. Mips are rebuilt for the whole texture unless `mips: false`.
- Data textures are shader resources the CPU writes, with no mips. Read them with `Load`, the portable read. `rgba16f` and `r16f` take a `Uint16Array` of half-float bits, or numbers, which are converted (`ToHalfFloat`). Filtered `Sample` of a 32-bit float texture needs `float32-filterable` on WebGPU and `OES_texture_float_linear` on WebGL2.
- A canvas that never had a drawing context can be passed to `CreateTextureFromImage`. It holds transparent black, and that is what the texture holds. Current Chrome prints a console warning on WebGPU and writes nothing (the new texture is zeroed anyway). An older build that throws is caught, and zeros are written. To avoid the warning, pass an `ImageData`.
- Textures made here are kept out of the engine's idle sweep (`_neverPurge`), because nothing could load them again. Free them with `ReleaseTexture`.

### Geometry made in memory: releasing it

A geometry's vertices and indices go into the engine's single shared, sub-allocated device buffer at its first draw. That buffer is made of 32 MB blocks, up to 2 GB. Each geometry uses 3 slices: vertices, indices and reversed indices. The pool keeps a list of every slice it has handed out. **Dropping your references frees nothing.** The slices stay reserved for the life of the page. To free them, release the geometry:

```js
import { ReleaseGeometry, GeometryPoolStats } from "@geravant/carbon-runtime-slim";
ReleaseGeometry(geometry);   // slices back to the pool (the next geometry reuses them), CPU copies dropped; meshes on it draw nothing
GeometryPoolStats();         // { allocations, bytes, blocks, blockBytes }, for a leak check in a test
```

Proof (`requests.html`, `release`): 300 geometries drawn take 900 slices. `ReleaseGeometry` returns the count to where it started. The next 300 reuse the same block. 300 dropped without a release keep all 900 slices. The pool's blocks are never given back to the browser. A `Tr2Mesh` needs no release of its own.

The engine's idle sweep (`TriDevice.CollectResources`, every 60 s, for resources unused for 30 s) does not touch these geometries, nor textures made here. It does release an idle `Tr2RenderTarget` or `Tr2DepthStencil` and its pixels. The next use brings it back after one device tick, so the first frame after a long pause draws into nothing. A host that keeps targets across screens it leaves for minutes should draw one frame, or check `IsValid()`, before relying on them.

### Render targets as a view's output, at any size

A view's last pass can draw into a `Tr2RenderTarget` instead of the canvas, and another effect can sample that target. This is the intended route, and it works on both backends:

```js
esm.SetRenderTarget(0, plate.GetRenderTarget()); esm.SetDepthStencilBuffer(null); esm.SetViewport({ x: 0, y: 0, width, height });
// ... the pass ...
sheet.SetParameter__TextureAL("SkyPlate", plate.GetRenderTarget());
```

Row 0 of a target is its top, so `v` runs down on both backends: the proof page's paper pass reads its scene target by pixel and the picture lands the same way up on WebGPU and WebGL2. Three rules, all found on the proof page (`halfResolution`):

- **Bind targets, the canvas included, through the effect state manager** (`esm.SetRenderTarget(0, backend.GetCanvasTarget())`) whenever an earlier step bound a target of another size. `backend.al.SetRenderTarget` bypasses the manager, so it keeps the old target's extent. It then clips the next viewport to that extent and scales full-screen texture coordinates by it. On WebGPU the canvas showed a quarter of the picture. With same-size targets throughout, as before, either call works.
- `SetFullScreenViewport()` is the bound target's size only when the manager bound it. Otherwise set the viewport explicitly.
- `TriStepRenderEffect`'s texture coordinates are scaled to the manager's device viewport (`Tr2RenderUtils.adjustTextureCoordsToViewport`). A full-screen pass into a target smaller than the device should read its source by `SV_Position` (`effects/req/paper.fx`).

**Half resolution with a filtered upsample** works with these calls: draw into half-size targets with their own viewport, then run a `TriStepRenderEffect` with our filtered blit (`effects/system/blitfiltered.fx`, `BlitSource`, `MIN_MAG_MIP_LINEAR`) onto the canvas, bound through the manager. On the proof page the flat regions match the full-resolution picture exactly on both backends; edges soften.

**Releasing a target:** `ReleaseRenderTarget(target)` (also for a `Tr2DepthStencil`) destroys the device texture and the creation parameters, so nothing rebuilds it, and it leaves the device registry. `Create` makes it again. `target.ReleaseResources()` with no argument **does nothing**, because it takes a storage mask. With a mask it frees the texture but keeps the parameters, and the next use rebuilds it. Proof `targets`.

### Instance streams with a capacity

`InstanceStream` is a `Tr2RuntimeInstanceData` whose device allocation is a power of two, at least `minCapacity` rows (64 by default). It keeps that allocation while the rows fit, so a stream whose length changes every frame does not reallocate, and it needs no padding rows. The draw uses the row count.

```js
const sprites = new InstanceStream({ minCapacity: 64 });
sprites.SetElementLayout(layout); sprites.SetData(rows); sprites.UpdateData();   // as before; GetCapacity() tells the rows held
```

### Lines clipped to a span, with no resubmit

`CurveLineSpans` holds a span per line of a `Tr2CurveLineSet` in a small float texture. The line effect reads the span by the line's id, so changing a span is a 16-byte texture write and the vertex buffer is not touched.

```js
const spans = new CurveLineSpans();
spans.Bind(lineEffect);                 // the effect's Texture2D LineSpans
spans.Set(courseId, shipAt, 1);         // draw from shipAt to the end (0..1 along the line); start > end hides it
spans.Upload();                         // once a frame, before drawing
```

The shader side is `examples/shattered-spike/effects/req/LineSpan.fxh`. Include it, pass `along.y` (TEXCOORD1.y) and the id (TEXCOORD2.z) to the pixel stage, and `discard` outside `LineSpan(id)`. `spanline.fx` is a complete line effect. "Along" is the curve parameter: exact for straight lines, and even steps per segment on a curve. The free per-line pair from `ChangeLineAnimation` (TEXCOORD2.xy) is still there.

### GPU time per job

```js
const { backend } = await ShatteredBoot({ ..., gpuTimer: true });     // asks WebGPU for timestamp-query where the adapter has it
const { method, gpuMs, cpuMs } = await TimeJob(job);                  // runs the job once, as DrawNow(job)
const blocking = TimeJobNow(job);                                     // WebGL2: draw, then read one canvas pixel back; the true cost on SwiftShader
```

| `method` | Where | What `gpuMs` is |
|---|---|---|
| `timestamp` | WebGPU with `timestamp-query` | The GPU time of exactly that job: timestamps written by passes submitted just before and just after its command buffers, in the same submit. Chrome rounds to 100 µs without `--enable-webgpu-developer-features`. |
| `done` | WebGPU without it | From the job's start to `onSubmittedWorkDone`. |
| `timer-query` | WebGL2 with `EXT_disjoint_timer_query_webgl2` (Chrome on Metal and on SwiftShader both have it) | One `TIME_ELAPSED` query around the job. `null` after a disjoint period. |
| `fence` | WebGL2 without the extension | From the job's start to a fence signalling, polled at about 1 ms. |
| `readback` (`TimeJobNow`, WebGL2) | everywhere | Wall time of the draw plus a one-pixel read of the canvas. `gl.finish()` returns before SwiftShader has drawn, so it is not used. |

Measured at 480×270 on the proof page: WebGPU on Metal, 0.05 to 0.1 ms; WebGL2 on Metal, 0.07 to 0.1 ms (timer query); SwiftShader WebGL2, 33 to 65 ms (timer query) and 13 to 52 ms (readback) under load; SwiftShader WebGPU, 9 to 40 ms.

### The orbit camera's field of view

`EveCamera` honours `fieldOfView` (vertical, in radians) when `zoomCurve = null`, but only up to an aspect ratio of 1.6. At wider aspects Carbon narrows the picture by `1.6 / aspect`, so a 16:9 view shows 0.9 of the asked tangent. `OrbitCamera` is `EveCamera` with no zoom curve, no idle sway and that clamp undone. `fieldOfView` is then the vertical field of view at every aspect. `UpdateSeconds(seconds, aspect)` and `StableUpdateSeconds` take seconds. `Update` takes Blue ticks (`CcpTime.timeFromDouble(seconds)`), as before.

### Effects

Effects are HLSL `.fx` files in the engine's effect syntax. The package carries the engine's own effect compiler as a command and as a function:

```sh
npx carbon-fx --src src/carbon/effects --out public/res --prefix shattered --clean
```

```js
import { BuildEffects } from "@geravant/carbon-runtime-slim/fx";
const { written, failed } = BuildEffects({ src: "src/carbon/effects", out: "public/res", prefix: "shattered", clean: true });
```

`<src>/a/name.fx` becomes `<out>/graphics/effect.webgpu/<prefix>/a/name.sm_{depth,hi,lo}` (WGSL) and `<out>/graphics/effect.webgl/<prefix>/a/name.sm_*` (GLSL ES 3.00). The page names it `res:/graphics/effect/<prefix>/a/name.fx`. `--targets webgpu` or `--models depth` narrow what is written.

## Machines with no GPU (the test server)

Checked on the test server in a container built like the game's stand image (Debian Chromium 156, `--network none`, 2 CPUs, 2 GB), at 1280×720:

| Chromium flags | Backend the page gets | Result |
|---|---|---|
| `--enable-unsafe-swiftshader --use-angle=swiftshader` (what `stand/chrome.sh` passes today) | WebGL2, by the engine's own fallback (Linux Chromium offers no WebGPU adapter by default) | draws correctly; a canvas read returns real pixels |
| the same plus `--enable-unsafe-webgpu --use-webgpu-adapter=opengles --ignore-gpu-blocklist` | WebGPU on Dawn's SwiftShader adapter | draws correctly; a canvas read returns real pixels |
| `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader` (with or without `--enable-features=Vulkan`) | none: an adapter is offered but every device request fails | page error |
| those plus `--use-vulkan=swiftshader --disable-vulkan-surface --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan --disable-gpu-sandbox` | WebGPU device works, GPU readback is right | the canvas is never presented: screenshots and canvas reads are blank |

So the stand needs no change for the WebGL2 path, and one more flag set to test the WebGPU path.

Software rendering is slow and scales with pixels, not ships. One frame of the spike (hull pass, normal pass, full-screen watercolour pass) takes about 0.7 s on WebGL2 and 0.9 s on WebGPU at 1280×720, 0.9 s and 1.1 s with 30 ships, and about 0.12 s and 0.16 s at 480×270. The engine's own CPU time is 1 to 2 ms a frame. Tests on the server should use a small canvas, wait for a frame count instead of a time, and read scene state from data attributes; a canvas read works when a pixel check is wanted.

Read the canvas inside the frame that drew it (same task as `blue.os.PumpOS()`), by `drawImage` onto a 2D canvas: a WebGPU canvas is cleared after it is presented. `examples/shattered-spike/tools/box/` holds the image and probes used.

## What is in the bundle

`shattered/src/index.js` is the list of what the package exports. `shattered/dist/sizes.json` (also `carbon.minifiedAlwaysLoaded` in the package's `package.json`) gives the minified size of what a page always loads. The browser backend with the WebGPU layer, and the WebGL2 layer, are separate chunks fetched when a backend is acquired. The DXBC effect translators are not in the package, so `AcquireBackend` must be called with `translator: false` (`ShatteredBoot` does).

Three things are swapped at build time instead of editing engine files (`shattered/scripts/build-slim.mjs`):

- the Trinity barrel that `CjsLibrary` imports (every Trinity and EVE class) is replaced by `shattered/src/trinityForLibrary.js`, which names the five classes `CjsLibrary` uses;
- the engine's default resource registrations (`src/core/configuration.js`) are replaced by `shattered/src/configuration.js`, which registers compiled effect containers only;
- the dynamic imports of SOF, character and audio in `CjsLibrary`, and of the two DXBC effect translators and the Black reader, resolve to one shared empty module. It is a single chunk, `dist/chunks/absent-<hash>.js`; no file in the package is named after a module that was left out, and the build fails if one is.

A host that needs a file format (textures, for example) passes it in `ShatteredBoot`'s `configuration` option, in the engine's own configuration vocabulary. The build fails if two exported barrels export the same name with different meanings (`export *` would silently export neither); name the wanted one in `shattered/src/index.js`.
