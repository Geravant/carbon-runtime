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

The package is one ES module with lazy chunks and no dependencies. Vite bundles it as it is. The package's files are not minified; the game's production build minifies them.

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

## What is in the bundle

`shattered/src/index.js` is the list of what the package exports. `shattered/dist/sizes.json` (also `carbon.minifiedAlwaysLoaded` in the package's `package.json`) gives the minified size of what a page always loads. The browser backend with the WebGPU layer, and the WebGL2 layer, are separate chunks fetched when a backend is acquired. The two DXBC translator chunks are in the package but are only fetched by a host that asks for a translator; ours does not.

Three things are swapped at build time instead of editing engine files (`shattered/scripts/build-slim.mjs`):

- the Trinity barrel that `CjsLibrary` imports (every Trinity and EVE class) is replaced by `shattered/src/trinityForLibrary.js`, which names the five classes `CjsLibrary` uses;
- the engine's default resource registrations (`src/core/configuration.js`) are replaced by `shattered/src/configuration.js`, which registers compiled effect containers only;
- the dynamic imports of SOF, character and audio in `CjsLibrary` resolve to an empty module.

A host that needs a file format (textures, for example) passes it in `ShatteredBoot`'s `configuration` option, in the engine's own configuration vocabulary. The build fails if two exported barrels export the same name with different meanings (`export *` would silently export neither); name the wanted one in `shattered/src/index.js`.
