// Runs the spike page in headless system Chrome with WebGPU and captures it.
//
//   node examples/shattered-spike/tools/shoot.mjs [--probe] [--bench] [--angles 0,45,...] [--ships N]
//
// Serves examples/shattered-spike/ from a free local port for the run and stops the server at
// the end. Audio is muted. Screenshots go to ../shots/.
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

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [ "--mute-audio", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--ignore-gpu-blocklist", ...(flag("--novsync") ? [ "--disable-gpu-vsync", "--disable-frame-rate-limit" ] : []) ]
});
const width = Number(option("--width", 1280)), height = Number(option("--height", 720));
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(option("--ratio", 1)) });
const log = [];

async function open(query)
{
  const page = await context.newPage();
  page.on("console", message => log.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", error => log.push(`[pageerror] ${error.stack ?? error}`));
  const started = Date.now();
  await page.goto(`${base}index.html?${query}`);
  await page.waitForFunction(() => window.__spike && (window.__spike.error || (window.__spike.ready && window.__spike.frames > 5)), null, { timeout: Number(option("--wait", 20000)) }).catch(() => {});
  const state = await page.evaluate(() => ({ ready: window.__spike?.ready, error: window.__spike?.error, frames: window.__spike?.frames, firstFrameMs: window.__spike?.firstFrameMs, backend: window.__spike?.backendName, diagnostics: (window.__spike?.diagnostics ?? []).slice(0, 6), jobStatus: window.__spike?.status?.() }));
  state.wallMs = Date.now() - started;
  return { page, state };
}

try
{
  await mkdir(join(root, "shots"), { recursive: true });
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
      results.push({ ships: Number(count), firstFrameMs: state.firstFrameMs, error: state.error, bench });
      await page.screenshot({ path: join(root, "shots", `bench-${count}-ships.png`) });
      await page.close();
    }
    console.log(JSON.stringify({ results, requests: requests.filter(r => !r.path.startsWith("shots")) }, null, 1));
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
        await page.screenshot({ path: join(root, "shots", name) });
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
  await writeFile(join(root, "shots", "requests.json"), `${JSON.stringify(requests.filter(r => !r.path.startsWith("shots")), null, 1)}\n`);
  const missing = requests.filter(r => r.missing);
  console.log(`requests: ${requests.length}, unanswered: ${missing.length}${missing.length ? ` (${[ ...new Set(missing.map(r => r.path)) ].join(", ")})` : ""}`);
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
