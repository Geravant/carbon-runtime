// Runs the spike page in headless system Chrome with WebGPU and captures it.
//
//   node examples/shattered-spike/tools/shoot.mjs [--probe] [--bench] [--angles 0,45,...] [--ships N]
//        [--backend webgpu|webgl2] [--gpu metal|swiftshader|stand] [--out m1] [--executable <chromium>] [--strict]
//
// Serves examples/shattered-spike/ from a free local port for the run and stops the server at
// the end. Audio is muted. Screenshots go to ../shots/ (or ../shots/<--out>/).
//
// --backend webgl2 runs Chrome with WebGPU disabled (no adapter), so the page falls back to WebGL2.
// --gpu swiftshader runs on the software rasteriser, as a machine with no GPU does: WebGPU through
//   Dawn's SwiftShader adapter, WebGL2 through ANGLE on SwiftShader.
// --executable names a Chromium binary instead of the installed Chrome (the test server's).
// --strict exits 1 when the page failed, a request went unanswered, or the canvas read is blank.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream", ".png": "image/png" };
const BACKEND = option("--backend", "webgpu");
const GPU = option("--gpu", process.platform === "darwin" ? "metal" : "swiftshader");
const OUT = option("--out", "");
let failed = false;
const requests = [];
const server = createServer(async (request, response) =>
{
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^([/\\])+/u, "");
  try
  {
    const body = await readFile(join(root, path || "index.html"));
    requests.push({ path: path || "index.html", bytes: body.length });
    response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  }
  catch
  {
    requests.push({ path, bytes: 0, missing: true });
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const gpuArgs = {
  "webgpu/metal": [ "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--ignore-gpu-blocklist" ],
  "webgl2/metal": [ "--disable-features=WebGPUService", "--use-angle=metal", "--ignore-gpu-blocklist" ],
  // WebGPU with no GPU, found by trial on the test server (Debian Chromium 156 in the stand's image). Asking
  // for the "opengles" adapter still gives Dawn's SwiftShader adapter, and it is the only set tried where the
  // device survives AND the canvas is presented (screenshot, drawImage and GPU readback all agree). With
  // --use-webgpu-adapter=swiftshader the adapter is offered but every device request fails ("A valid external
  // Instance reference no longer exists"); adding --use-vulkan=swiftshader --disable-vulkan-surface and the
  // ANGLE-on-Vulkan features keeps the device alive but the canvas stays blank.
  "webgpu/swiftshader": [ "--enable-unsafe-webgpu", "--use-webgpu-adapter=opengles", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ],
  // Exactly what the game's stand wrapper passes (stand/chrome.sh), nothing else: WebGPU is off by default in
  // Linux Chromium, so the page's own fallback has to land on WebGL2.
  "webgl2/stand": [ "--enable-unsafe-swiftshader", "--use-angle=swiftshader" ],
  "webgl2/swiftshader": [ "--disable-features=WebGPUService", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist" ]
}[`${BACKEND}/${GPU}`];
if (!gpuArgs) throw new Error(`no flag set for --backend ${BACKEND} --gpu ${GPU}`);
const extraArgs = option("--chrome-args", "").split(" ").filter(Boolean);
const browser = await chromium.launch({
  ...(option("--executable") ? { executablePath: option("--executable") } : { channel: "chrome" }),
  headless: true,
  args: [ "--mute-audio", "--no-sandbox", ...gpuArgs, ...extraArgs, ...(flag("--novsync") ? [ "--disable-gpu-vsync", "--disable-frame-rate-limit" ] : []) ]
});
const width = Number(option("--width", 1280)), height = Number(option("--height", 720));
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(option("--ratio", 1)) });
const log = [];
const shots = join(root, "shots", OUT);

async function open(query)
{
  const page = await context.newPage();
  page.on("console", message => log.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", error => log.push(`[pageerror] ${error.stack ?? error}`));
  const started = Date.now();
  // On WebGL2 runs the page keeps its default preference (WebGPU, then WebGL2): the browser has no
  // WebGPU adapter, so reaching WebGL2 is the engine's own fallback. --force-backend asks for it by name.
  await page.goto(`${base}index.html?${flag("--force-backend") ? `backend=${BACKEND}&` : ""}${query}`);
  await page.waitForFunction(() => window.__spike && (window.__spike.error || (window.__spike.ready && window.__spike.frames > 5)), null, { timeout: Number(option("--wait", 20000)) }).catch(() => {});
  const state = await page.evaluate(() => ({ ready: window.__spike?.ready, error: window.__spike?.error, frames: window.__spike?.frames, firstFrameMs: window.__spike?.firstFrameMs, backend: window.__spike?.backendName, adapter: window.__spike?.adapter, diagnostics: (window.__spike?.diagnostics ?? []).slice(0, 6), jobStatus: window.__spike?.status?.() }));
  state.wallMs = Date.now() - started;
  state.webgpuAdapter = await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)));
  if (state.backend !== BACKEND) failed = true;
  // What a canvas read gives back, taken inside a frame: a blank or single-colour canvas is not a picture.
  if (state.ready && !state.error) state.canvasRead = await page.evaluate(() => window.__spike.readCanvas());
  if (!state.ready || state.error || state.diagnostics.length || !(state.canvasRead?.distinctColours > 50)) failed = true;
  return { page, state };
}

try
{
  await mkdir(shots, { recursive: true });
  const ships = option("--ships", "1");
  const extra = option("--query", "");
  if (flag("--bench"))
  {
    const results = [];
    for (const count of option("--counts", "1,30").split(","))
    {
      const { page, state } = await open(`ships=${count}&bench=${option("--frames", 300)}&${extra}`);
      await page.waitForFunction(() => window.__spike.bench || window.__spike.error, null, { timeout: 120000 }).catch(() => {});
      const bench = await page.evaluate(() => window.__spike.bench);
      results.push({ ships: Number(count), backend: state.backend, adapter: state.adapter, firstFrameMs: state.firstFrameMs, error: state.error, canvasRead: state.canvasRead, bench });
      await page.screenshot({ path: join(shots, `${BACKEND}-bench-${count}-ships.png`) });
      await page.close();
    }
    console.log(JSON.stringify({ results }, null, 1));
    await writeFile(join(shots, `bench-${BACKEND}.json`), `${JSON.stringify({ gpu: GPU, results }, null, 1)}\n`);
  }
  else if (flag("--sequence"))
  {
    // A frame sequence under a moving camera, time stepped by hand so every run gives the same frames,
    // and how much of the picture changes between neighbouring frames a sixtieth of a second apart.
    const camera = option("--sequence", "perspective");
    const count = Number(option("--frames", 36)), step = Number(option("--step", camera === "flyby" ? 8 / 36 : 1 / 6));
    const { page, state } = await open(`ships=${ships}&camera=${camera}&hold=1&${extra}`);
    console.log(JSON.stringify(state));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const directory = join(shots, option("--name", camera));
    await mkdir(directory, { recursive: true });
    for (let i = 0; i < count; i++)
    {
      await page.evaluate(t => window.__spike.setTime(t), i * step);
      await settle();
      await page.screenshot({ path: join(directory, `${String(i).padStart(3, "0")}.jpg`), type: "jpeg", quality: 88 });
    }
    const stability = [];
    for (const t of [ 1, 2.5, 4, 5.5 ])
    {
      const shots = [];
      for (const time of [ t, t + 1 / 60 ])
      {
        await page.evaluate(value => window.__spike.setTime(value), time);
        await settle();
        shots.push((await page.screenshot({ type: "png" })).toString("base64"));
      }
      stability.push({ t, ...await page.evaluate(async ([ a, b ]) =>
      {
        const load = async data => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const [ ia, ib ] = [ await load(a), await load(b) ];
        const canvas = new OffscreenCanvas(ia.width, ia.height), context = canvas.getContext("2d", { willReadFrequently: true });
        const pixels = image => { context.drawImage(image, 0, 0); return context.getImageData(0, 0, ia.width, ia.height).data; };
        const pa = pixels(ia).slice(), pb = pixels(ib);
        let changed = 0, strong = 0, sum = 0;
        const total = ia.width * ia.height;
        for (let i = 0; i < total; i++)
        {
          const d = Math.max(Math.abs(pa[i * 4] - pb[i * 4]), Math.abs(pa[i * 4 + 1] - pb[i * 4 + 1]), Math.abs(pa[i * 4 + 2] - pb[i * 4 + 2]));
          sum += d;
          if (d > 8) changed++;
          if (d > 48) strong++;
        }
        return { changedPercent: +(changed / total * 100).toFixed(3), strongPercent: +(strong / total * 100).toFixed(3), meanDifference: +(sum / total).toFixed(3) };
      }, shots) });
    }
    await writeFile(join(directory, "stability.json"), `${JSON.stringify({ camera, step: 1 / 60, note: "share of pixels whose colour changes by more than 8 (changed) and 48 (strong) of 255 between two frames 1/60 s apart", stability }, null, 1)}\n`);
    console.log(JSON.stringify(stability));
    await page.close();
  }
  else
  {
    const angles = flag("--probe") ? [ 30 ] : option("--angles", "0,45,90,135,180,225,270,315").split(",").map(Number);
    const { page, state } = await open(`ships=${ships}&yaw=${angles[0]}&${extra}`);
    console.log(JSON.stringify(state, null, 1));
    if (flag("--debug")) console.log(JSON.stringify(await page.evaluate(() => window.__spike.debug?.())));
    if (state.ready && !state.error)
    {
      for (const angle of angles)
      {
        await page.evaluate(degrees => window.__spike.setYaw(degrees), angle);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
        const name = `${option("--name", `ship-${ships}`)}-${String(angle).padStart(3, "0")}.png`;
        await page.screenshot({ path: join(shots, name) });
        console.log(`shots/${name}`);
      }
    }
    await page.close();
  }
}
finally
{
  if (log.length) console.log(log.slice(0, Number(option("--log", 40))).join("\n"));
  // The miss log: every path the page asked this server for, and whether a file of ours answered.
  await writeFile(join(shots, `requests-${BACKEND}.json`), `${JSON.stringify(requests.filter(r => !r.path.startsWith("shots")), null, 1)}\n`);
  const missing = requests.filter(r => r.missing);
  console.log(`requests: ${requests.length}, unanswered: ${missing.length}${missing.length ? ` (${[ ...new Set(missing.map(r => r.path)) ].join(", ")})` : ""}`);
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (missing.length) failed = true;
  if (flag("--strict") && failed) process.exitCode = 1;
}
