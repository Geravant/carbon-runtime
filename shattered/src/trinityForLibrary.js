// The slim build's stand-in for the Trinity barrel as src/core/CjsLibrary.js imports it (see
// scripts/build-slim.mjs). CjsLibrary takes five names from `../trinity/index.js`, which also
// brings every Trinity and EVE class with it; here the same five come from their own modules.
// If upstream's CjsLibrary starts importing another name from the barrel, the slim build fails
// with "No matching export" naming it: add it here.
export { trinity } from "../../src/trinity/CjsTrinity.js";
export { TriDevice } from "../../src/trinity/core/device/TriDevice.js";
export { Tr2FontManager } from "../../src/trinity/font/Tr2FontManager.js";
export { Tr2Renderer } from "../../src/trinity/core/Tr2Renderer.js";
export { Tr2RenderContext_GetMainThreadRenderContext } from "../../src/trinity/core/context/Tr2RenderContext.js";
