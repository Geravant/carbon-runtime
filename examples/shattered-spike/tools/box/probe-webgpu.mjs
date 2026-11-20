// Does this Chromium give a WebGPU adapter and a device that survives a draw, per flag set?
import { chromium } from "playwright-core";
const sets = {
  swiftshader: [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-sandbox" ],
  "swiftshader-vulkan": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-sandbox", "--disable-vulkan-surface" ],
  "swiftshader-noangleflag": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ],
  "compat-gles": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=opengles", "--enable-features=WebGPUExperimentalFeatures", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ],
  "in-process-gpu": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--in-process-gpu" ]
};
Object.assign(sets, {
  "angle-only": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ],
  "stand-wrapper": [ "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader" ],
  "vulkan-noangle": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--disable-vulkan-surface", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ]
});
const only = process.argv[2] ? process.argv[2].split(",") : Object.keys(sets);
for (const name of only)
{
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: [ "--mute-audio", "--no-sandbox", ...sets[name] ] });
  const page = await browser.newPage();
  const log = [];
  page.on("console", message => { if (log.length < 6) log.push(message.text().slice(0, 200)); });
  await page.route("https://m1.test/", route => route.fulfill({ contentType: "text/html", body: "<canvas id=c width=256 height=256></canvas>" }));
  await page.goto("https://m1.test/");
  const result = await page.evaluate(async () =>
  {
    const out = { gpu: !!navigator.gpu };
    if (!navigator.gpu) return out;
    const adapter = await navigator.gpu.requestAdapter().catch(error => { out.adapterError = String(error); return null; });
    out.adapter = adapter ? `${adapter.info?.vendor} ${adapter.info?.architecture} ${adapter.info?.device} ${adapter.info?.description} fallback=${adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter}` : null;
    if (!adapter) return out;
    let first = adapter;
    const tryDevice = async (label, descriptor) =>
    {
      const a = first ?? await navigator.gpu.requestAdapter();
      first = null;
      let lost = null;
      try
      {
        const device = await a.requestDevice(descriptor);
        device.lost.then(info => { lost = `${info.reason}: ${info.message}`; });
        const errors = [];
        device.addEventListener("uncapturederror", event => errors.push(String(event.error?.message).slice(0, 200)));
        const canvas = document.getElementById("c");
        const context = canvas.getContext("webgpu");
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format });
        const module = device.createShaderModule({ code: "@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(p[i], 0, 1); } @fragment fn f() -> @location(0) vec4f { return vec4f(0.2, 0.6, 0.9, 1); }" });
        const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module }, fragment: { module, targets: [ { format } ] } });
        const hdr = device.createTexture({ size: [ 256, 256 ], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        const depth = device.createTexture({ size: [ 256, 256 ], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        const started = performance.now();
        for (let frame = 0; frame < 3; frame++)
        {
          const encoder = device.createCommandEncoder();
          encoder.beginRenderPass({ colorAttachments: [ { view: hdr.createView(), loadOp: "clear", storeOp: "store", clearValue: [ 0, 0, 0, 1 ] } ], depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } }).end();
          const pass = encoder.beginRenderPass({ colorAttachments: [ { view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [ 0, 0, 0, 1 ] } ] });
          pass.setPipeline(pipeline);
          pass.draw(3);
          pass.end();
          device.queue.submit([ encoder.finish() ]);
          await device.queue.onSubmittedWorkDone();
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        out[label] = { ok: true, ms: Math.round(performance.now() - started), lost, errors, depthOk: !!depth };
        const probe = document.createElement("canvas").getContext("2d");
        probe.canvas.width = probe.canvas.height = 256;
        probe.drawImage(canvas, 0, 0);
        out[label].pixel = [ ...probe.getImageData(128, 128, 1, 1).data ];
        device.destroy();
      }
      catch (error) { out[label] = { ok: false, error: String(error).slice(0, 300), lost }; }
    };
    await tryDevice("plainDevice", undefined);
    // What the engine's CjsBrowserBackend asks for.
    const wanted = [ "texture-compression-bc", "texture-compression-bc-sliced-3d", "float32-filterable", "float32-blendable", "depth-clip-control", "texture-formats-tier2" ].filter(feature => adapter.features.has(feature));
    await tryDevice("engineDevice", { requiredFeatures: wanted, requiredLimits: { maxStorageTexturesPerShaderStage: Math.min(16, adapter.limits.maxStorageTexturesPerShaderStage), maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D), maxBufferSize: Math.min(2147483648, adapter.limits.maxBufferSize) } });
    return out;
  }).catch(error => ({ evaluateError: String(error).slice(0, 300) }));
  console.log(name, JSON.stringify(result), log.length ? JSON.stringify(log) : "");
  await browser.close().catch(() => {});
}
