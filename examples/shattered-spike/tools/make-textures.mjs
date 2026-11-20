// Draws the spike's own test images in headless Chrome and writes them as files:
//   res/textures/backdrop.jpg  1920x1080 JPEG, a painted wash with fine lines (shows filtering)
//   res/textures/marker.png    256x256 PNG with alpha, a ringed marker
// Everything is drawn here from a seeded generator; nothing is downloaded.
//
//   node examples/shattered-spike/tools/make-textures.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "res", "textures");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [ "--mute-audio" ] });
try
{
  const page = await browser.newPage();
  const images = await page.evaluate(async () =>
  {
    let seed = 20261120;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const encode = async (canvas, type, quality) =>
    {
      const blob = await canvas.convertToBlob({ type, quality });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    };

    const backdrop = new OffscreenCanvas(1920, 1080);
    let c = backdrop.getContext("2d");
    const sky = c.createLinearGradient(0, 0, 1920, 1080);
    sky.addColorStop(0, "#1d2440"); sky.addColorStop(0.5, "#3b2f5c"); sky.addColorStop(1, "#0f1a2c");
    c.fillStyle = sky; c.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 90; i++)
    {
      const x = random() * 1920, y = random() * 1080, r = 60 + random() * 320;
      const wash = c.createRadialGradient(x, y, 0, x, y, r);
      const hue = [ 205, 262, 330, 28 ][i % 4] + random() * 24;
      wash.addColorStop(0, `hsla(${hue}, 62%, ${38 + random() * 26}%, 0.34)`);
      wash.addColorStop(1, `hsla(${hue}, 62%, 40%, 0)`);
      c.fillStyle = wash; c.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 900; i++)
    {
      c.fillStyle = `rgba(255, 248, 230, ${0.25 + random() * 0.7})`;
      const s = random() < 0.92 ? 1 : 2;
      c.fillRect(Math.floor(random() * 1920), Math.floor(random() * 1080), s, s);
    }
    // One-pixel lines and a fine checker: point sampling aliases these under scaling, linear filtering does not.
    c.strokeStyle = "rgba(240, 230, 200, 0.55)"; c.lineWidth = 1;
    for (let i = 0; i < 40; i++) { c.beginPath(); c.moveTo(0, 540.5 + (i - 20) * 9); c.lineTo(1920, 300.5 + (i - 20) * 23); c.stroke(); }
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) { c.fillStyle = (x + y) & 1 ? "#f2ead8" : "#1a1830"; c.fillRect(64 + x * 2, 64 + y * 2, 2, 2); }
    c.fillStyle = "#f2ead8"; c.font = "600 44px Georgia, serif"; c.fillText("Shattered Reach test backdrop (JPEG)", 300, 150);

    const marker = new OffscreenCanvas(256, 256);
    c = marker.getContext("2d");
    c.clearRect(0, 0, 256, 256);
    c.lineWidth = 14; c.strokeStyle = "rgba(226, 92, 58, 1)"; c.beginPath(); c.arc(128, 128, 96, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 6; c.strokeStyle = "rgba(250, 236, 200, 0.9)"; c.beginPath(); c.arc(128, 128, 60, 0.4, Math.PI * 1.6); c.stroke();
    c.fillStyle = "rgba(40, 60, 120, 0.5)"; c.beginPath(); c.arc(128, 128, 44, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#faecc8"; c.font = "700 34px Georgia, serif"; c.textAlign = "center"; c.fillText("PNG", 128, 140);

    return { "backdrop.jpg": await encode(backdrop, "image/jpeg", 0.9), "marker.png": await encode(marker, "image/png") };
  });
  await mkdir(out, { recursive: true });
  for (const [ name, bytes ] of Object.entries(images))
  {
    await writeFile(join(out, name), Buffer.from(bytes));
    console.log(`res/textures/${name}: ${bytes.length} bytes`);
  }
}
finally
{
  await browser.close();
}
