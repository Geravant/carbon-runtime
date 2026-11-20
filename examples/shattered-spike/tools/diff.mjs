// Compares two PNG screenshots pixel by pixel (in headless Chrome, which decodes them).
//   node examples/shattered-spike/tools/diff.mjs a.png b.png
// Prints the share of pixels that differ by more than 2 and by more than 16 of 255 in any channel.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const [ a, b ] = await Promise.all(process.argv.slice(2, 4).map(async file => (await readFile(file)).toString("base64")));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [ "--mute-audio" ] });
try
{
  const page = await browser.newPage();
  console.log(JSON.stringify(await page.evaluate(async ([ a, b ]) =>
  {
    const load = async data => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const [ ia, ib ] = [ await load(a), await load(b) ];
    if (ia.width !== ib.width || ia.height !== ib.height) return { error: "sizes differ" };
    const context = new OffscreenCanvas(ia.width, ia.height).getContext("2d", { willReadFrequently: true });
    const pixels = image => { context.drawImage(image, 0, 0); return context.getImageData(0, 0, ia.width, ia.height).data.slice(); };
    const pa = pixels(ia), pb = pixels(ib), total = ia.width * ia.height;
    let small = 0, large = 0, max = 0;
    for (let i = 0; i < total; i++)
    {
      const d = Math.max(Math.abs(pa[i * 4] - pb[i * 4]), Math.abs(pa[i * 4 + 1] - pb[i * 4 + 1]), Math.abs(pa[i * 4 + 2] - pb[i * 4 + 2]));
      if (d > 2) small++;
      if (d > 16) large++;
      if (d > max) max = d;
    }
    return { pixels: total, differBy3OrMorePercent: +(small / total * 100).toFixed(4), differBy17OrMorePercent: +(large / total * 100).toFixed(4), largestDifference: max };
  }, [ a, b ])));
}
finally
{
  await browser.close();
}
