// The slim build's stand-in for src/core/configuration.js (see scripts/build-slim.mjs): the
// default resource registrations of a host with its own content. Compiled effect containers
// only; no Black, GR2, DDS, IES or texture-pack readers. A host adds what it needs through
// CjsLibrary's configuration sections (`formats`, `extensions`, `objectLoaders`, ...).
import { Tr2EffectRes } from "../../src/trinity/shader/Tr2EffectRes.js";

const shaderExtensions = [ ...Tr2EffectRes.extensions, ...Tr2EffectRes.additionalExtensions ].map(extension => extension.toLowerCase());

export const DefaultConfiguration = {
  formatOptions: { buildClasses: true },
  formats: {},
  extensions: Object.fromEntries(shaderExtensions.map(extension => [ extension, Tr2EffectRes ])),
  objectLoaders: Object.fromEntries(shaderExtensions.map(extension => [ extension, Tr2EffectRes.readShaderResource ])),
  objectBuilders: {},
  resourceConstructors: {},
  imageHandlers: {},
  callbackModules: {},
  callbackMan: { useWorkers: false, threadCount: 2, mainThreadTimeSlice: 0.005 },
  effects: {},
  deviceResources: {},
  paths: {},
  resMan: {},
  settings: {},
  backends: {}
};
