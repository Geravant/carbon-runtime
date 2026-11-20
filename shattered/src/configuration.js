// The slim build's stand-in for src/core/configuration.js (see scripts/build-slim.mjs): the
// default resource registrations of a host with its own content. Compiled effect containers,
// and PNG and JPEG images as textures; no Black, GR2, DDS, IES or texture-pack readers. A host
// adds what it needs through CjsLibrary's configuration sections (`formats`, `extensions`,
// `objectLoaders`, ...).
import { CjsJpegFormat } from "../../src/resource/formats/jpeg/CjsJpegFormat.js";
import { CjsPngFormat } from "../../src/resource/formats/png/CjsPngFormat.js";
import { TriTextureRes } from "../../src/trinity/resources/texture/TriTextureRes.js";
import { Tr2EffectRes } from "../../src/trinity/shader/Tr2EffectRes.js";

const shaderExtensions = [ ...Tr2EffectRes.extensions, ...Tr2EffectRes.additionalExtensions ].map(extension => extension.toLowerCase());
// `res:/....png|jpg|jpeg` through resMan gives a TriTextureRes, decoded by the engine's own readers
// (in JS, on the main thread: ShatteredBoot starts no workers). ShatteredTextures.js is the faster way in.
const imageExtensions = [ "png", "jpg", "jpeg" ];

export const DefaultConfiguration = {
  formatOptions: { buildClasses: true },
  formats: {},
  extensions: {
    ...Object.fromEntries(imageExtensions.map(extension => [ extension, TriTextureRes ])),
    ...Object.fromEntries(shaderExtensions.map(extension => [ extension, Tr2EffectRes ]))
  },
  objectLoaders: {
    ...Object.fromEntries(imageExtensions.map(extension => [ extension, TriTextureRes.readImageResource ])),
    ...Object.fromEntries(shaderExtensions.map(extension => [ extension, Tr2EffectRes.readShaderResource ]))
  },
  objectBuilders: {},
  resourceConstructors: {},
  imageHandlers: { png: CjsPngFormat, jpeg: CjsJpegFormat },
  callbackModules: {},
  callbackMan: { useWorkers: false, threadCount: 2, mainThreadTimeSlice: 0.005 },
  effects: {},
  deviceResources: {},
  paths: {},
  resMan: {},
  settings: {},
  backends: {}
};
