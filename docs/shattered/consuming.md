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

### Fork additions the game should use

| Call | Replaces |
|---|---|
| `geometry.PrepareFromCmfData({ meshes: [...] })` on a `TriGeometryRes` | `SetupMeshes__CmfData` plus setting `_useCMF`, `_isPrepared` and `_isGood` by hand. Returns `true` when the resource is good. |
| `RawData.RegisterLayouts(groups, owner)` then `RawData.create("StructName")` | building layouts with `CjsConstantLayout.BuildLayouts` and calling the `RawData` constructor |
| `SetBuiltInEffectPaths({ blit, blitFiltered })` or the `effectPaths` option | serving our files at the engine's `managed/space/system/` paths |
| `AcquireBackend({ ..., translator: false })` (done by `ShatteredBoot`) | passing an `effects` section by hand |
| `Tr2DepthStencil.Create` now throws a `RangeError` for a format no backend can create | an invalid surface with no message |

On WebGL2 the canvas is `backend.al.GetDefaultBackBuffer()`; on WebGPU it is `backend.renderTarget`.

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
- To free one: `texture.ReleaseResources()`.

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
- the dynamic imports of SOF, character and audio in `CjsLibrary`, and of the two DXBC effect translators in `CjsBrowserBackend`, resolve to an empty module.

A host that needs a file format (textures, for example) passes it in `ShatteredBoot`'s `configuration` option, in the engine's own configuration vocabulary. The build fails if two exported barrels export the same name with different meanings (`export *` would silently export neither); name the wanted one in `shattered/src/index.js`.
