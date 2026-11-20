// On a WebGPU device that works: does a drawn canvas reach (a) a GPU readback, (b) a 2D-canvas copy in the
// same frame, (c) toDataURL, (d) a page screenshot?
import { chromium } from "playwright-core";
const base = [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ];
const sets = {
  "vulkan+nosurface": [ ...base, "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--use-vulkan=swiftshader", "--disable-gpu-sandbox", "--disable-vulkan-surface" ],
  "vulkan": [ ...base, "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--use-vulkan=swiftshader", "--disable-gpu-sandbox" ],
  "vulkan-sandboxed": [ ...base, "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--use-vulkan=swiftshader" ],
  "gles-adapter": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=opengles", "--enable-features=WebGPUExperimentalFeatures", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ],
  "gles-adapter-noexp": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=opengles", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ],
  "expfeatures-only": [ ...base, "--enable-features=WebGPUExperimentalFeatures" ]
};
const only = process.argv[2] ? process.argv[2].split(",") : Object.keys(sets);
for (const name of only)
{
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: [ "--mute-audio", "--no-sandbox", ...sets[name] ] });
  const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
  await page.route("https://m1.test/", route => route.fulfill({ contentType: "text/html", body: "<body style='margin:0;background:#204020'><canvas id=c width=256 height=256></canvas>" }));
  await page.goto("https://m1.test/");
  const result = await page.evaluate(async () =>
  {
    const out = {};
    try
    {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      device.lost.then(info => { out.lost = info.message; });
      const canvas = document.getElementById("c");
      const context = canvas.getContext("webgpu");
      const format = navigator.gpu.getPreferredCanvasFormat();
      out.format = format;
      context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, alphaMode: "opaque" });
      const module = device.createShaderModule({ code: "@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(p[i], 0, 1); } @fragment fn f() -> @location(0) vec4f { return vec4f(0.2, 0.6, 0.9, 1); }" });
      const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module }, fragment: { module, targets: [ { format } ] } });
      const buffer = device.createBuffer({ size: 256 * 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const probe = document.createElement("canvas").getContext("2d");
      probe.canvas.width = probe.canvas.height = 256;
      const times = [];
      for (let frame = 0; frame < 20; frame++)
      {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const started = performance.now();
        const texture = context.getCurrentTexture();
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [ { view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: [ 0, 0, 0, 1 ] } ] });
        pass.setPipeline(pipeline);
        pass.draw(3);
        pass.end();
        if (frame === 19) encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 1024 }, [ 256, 256 ]);
        device.queue.submit([ encoder.finish() ]);
        if (frame === 19)
        {
          probe.drawImage(canvas, 0, 0);
          out.drawImage = [ ...probe.getImageData(128, 128, 1, 1).data ];
          out.toDataURL = canvas.toDataURL().length;
          await device.queue.onSubmittedWorkDone();
          await buffer.mapAsync(GPUMapMode.READ);
          out.readback = [ ...new Uint8Array(buffer.getMappedRange(), (128 * 256 + 128) * 4, 4) ];
        }
        times.push(performance.now() - started);
      }
      out.adapter = `${adapter.info?.vendor} ${adapter.info?.architecture}`;
    }
    catch (error) { out.error = String(error).slice(0, 160); }
    return out;
  }).catch(error => ({ evaluateError: String(error).slice(0, 200) }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))).catch(() => {});
  const shot = await page.screenshot({ type: "png" }).catch(() => null);
  if (shot)
  {
    // The screenshot's centre pixel, decoded in the page.
    result.screenshot = await page.evaluate(async data =>
    {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return [ ...context.getImageData(128, 128, 1, 1).data ];
    }, shot.toString("base64")).catch(error => String(error).slice(0, 100));
  }
  console.log(name, JSON.stringify(result));
  await browser.close().catch(() => {});
}
