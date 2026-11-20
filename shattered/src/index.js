// The slim composition of the CarbonEngineJS runtime that Shattered Reach consumes.
//
// What a game with its own content needs, and nothing of EVE's: the device layers (WebGPU,
// and WebGL2 loaded on demand), Trinity core, render jobs and steps, the effect loader,
// geometry intake, Blue's services, maths and input. Not here: `trinity/eve`, SOF (ship
// assembly), character, audio, the DXBC effect translators and the EVE file formats.
//
// Built by ../scripts/build-slim.mjs into one ES module with lazy chunks; packed by
// ../scripts/pack.mjs. docs/shattered/consuming.md says how a game uses it.
export * from "../../src/global/math/index.js";
// Named here because two barrels below export a `PixelFormat` (the render context's, which device
// calls take, and Trinity's D3D-era enum); `export *` would silently export neither.
export { PixelFormat } from "../../src/global/consts/renderContext/formats.js";
export * from "../../src/global/consts/renderContext/index.js";
export * from "../../src/global/consts/graphics/index.js";
export * from "../../src/blue/index.js";
export * from "../../src/trinityal/index.js";
export * from "../../src/trinity/CjsTrinity.js";
export * from "../../src/trinity/core/index.js";
export * from "../../src/trinity/renderJob/index.js";
export * from "../../src/trinity/shader/index.js";
export * from "../../src/trinity/resources/index.js";
export * from "../../src/input/index.js";
// CPU particles: the system, its element declarations, emitters, generators, forces and constraints.
// The GPU particle systems (compute, and effects at fixed EVE paths) are not exported.
export { Tr2ParticleSystem } from "../../src/trinity/particle/Tr2ParticleSystem.js";
export { Tr2DynamicEmitter } from "../../src/trinity/particle/emitter/Tr2DynamicEmitter.js";
export { Tr2StaticEmitter } from "../../src/trinity/particle/emitter/Tr2StaticEmitter.js";
export * from "../../src/trinity/particle/ITr2GenericEmitter/index.js";
export * from "../../src/trinity/particle/element/index.js";
export * from "../../src/trinity/particle/attribute/index.js";
export * from "../../src/trinity/particle/force/index.js";
export * from "../../src/trinity/particle/constraint/index.js";
// The engine's orbit camera. It lives under trinity/eve in the source tree but depends on nothing there:
// maths, curves, TriView and TriProjection only.
export { EveCamera } from "../../src/trinity/eve/camera/EveCamera.js";
export { screenToProjection } from "../../src/trinity/core/view/pickRay.js";
export { CjsConstantLayout } from "../../src/trinity/core/rawData/CjsConstantLayout.js";
export { CjsLibrary } from "../../src/core/CjsLibrary.js";
export * from "./ShatteredRuntime.js";
export { CreateTextureFromImage, UpdateTextureFromImage, LoadTexture } from "./ShatteredTextures.js";
