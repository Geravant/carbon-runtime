// What a render job costs the GPU, per job, on both backends; and on a machine with no GPU (SwiftShader),
// the real cost of a software frame.
//
// TimeJob(job) runs the job once (as DrawNow(job)) and resolves with its GPU time, by the best method the
// device has:
//
//   "timestamp"   WebGPU with the `timestamp-query` feature (ShatteredBoot({ gpuTimer: true }) asks for it):
//                 two timestamps written by empty passes submitted right before and right after the job's own
//                 command buffers, in the same submit. Their difference is the GPU time of exactly that job.
//                 Chrome rounds timestamps to 100 us unless started with --enable-webgpu-developer-features.
//   "timer-query" WebGL2 with EXT_disjoint_timer_query_webgl2: one TIME_ELAPSED query round the job.
//                 A disjoint period (the GPU was switched or reset) gives no result (gpuMs null).
//   "fence"       WebGL2 without the extension (SwiftShader, most browsers): a fence after the job, polled;
//                 gpuMs is from the job's start to the fence signalled. That is when the frame's GPU work was
//                 done, including the job's CPU recording, polled at about 1 ms resolution.
//   "done"        WebGPU without timestamps: from the job's start to queue.onSubmittedWorkDone().
//
// TimeJobNow(job) is the blocking measure: DrawNow(job), then wait for the GPU by reading one pixel of the
// canvas back (WebGL2; gl.finish() was tried and returns before SwiftShader has drawn). On WebGPU there is no
// blocking wait, so it falls back to TimeJob. On software WebGL2 it is the frame's
// true cost and needs no polling; on a real GPU it stalls the pipeline, so use it in tests, not in play.
import { DrawNow } from "./ShatteredRuntime.js";

let host = null;   // { backend, device (GPUDevice) | gl }
const timestampPool = [];

/** Called by ShatteredBoot. */
export function SetTimingHost(backend)
{
  host = { backend };
  if (backend.webgpu)
  {
    host.gpu = backend.webgpu.GetDevice();
    host.timestamps = host.gpu.features.has("timestamp-query");
  }
  else
  {
    host.gl = backend.al.GetWebgl2();
    host.timerQuery = host.gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }
}

/**
 * Which method TimeJob uses on this device.
 *
 * @returns {"timestamp"|"done"|"timer-query"|"fence"} The method.
 */
export function GpuTimingMethod()
{
  if (!host) throw new Error("GpuTimingMethod needs ShatteredBoot to have run");
  if (host.gpu) return host.timestamps ? "timestamp" : "done";
  return host.timerQuery ? "timer-query" : "fence";
}

function TimestampSet()
{
  const gpu = host.gpu;
  const set = timestampPool.pop() ?? {
    querySet: gpu.createQuerySet({ type: "timestamp", count: 2, label: "shattered job timer" }),
    resolve: gpu.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, label: "shattered job timer resolve" }),
    read: gpu.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: "shattered job timer read" })
  };
  return set;
}

function TimestampMark(set, index, resolve)
{
  const gpu = host.gpu;
  // A pass that does real work (clearing one texel): an empty pass may be skipped by the driver, and its
  // timestamps with it (Metal samples counters only round work it encodes).
  host.markTarget ??= gpu.createTexture({ size: [ 1, 1 ], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT, label: "shattered job timer mark" });
  const encoder = gpu.createCommandEncoder({ label: `shattered job timer ${index}` });
  encoder.beginRenderPass({
    colorAttachments: [ { view: host.markTarget.createView(), loadOp: "clear", storeOp: "store", clearValue: [ 0, 0, 0, 0 ] } ],
    timestampWrites: index === 0 ? { querySet: set.querySet, beginningOfPassWriteIndex: 0 } : { querySet: set.querySet, endOfPassWriteIndex: 1 }
  }).end();
  if (resolve)
  {
    encoder.resolveQuerySet(set.querySet, 0, 2, set.resolve, 0);
    encoder.copyBufferToBuffer(set.resolve, 0, set.read, 0, 16);
  }
  return encoder.finish();
}

const nextTask = () => new Promise(resolve =>
{
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
  channel.port2.postMessage(0);
});

/**
 * Runs `job` once now (as `DrawNow(job)`) and measures its GPU time.
 *
 * @param {object} job A `TriRenderJob`.
 * @returns {Promise<{method: string, gpuMs: ?number, cpuMs: number, submits?: number}>} The job's GPU time in
 *   milliseconds (null when the device could not say: a disjoint timer query), and the CPU time `DrawNow` took.
 */
export async function TimeJob(job)
{
  const method = GpuTimingMethod();
  if (method === "timestamp")
  {
    const gpu = host.gpu, queue = gpu.queue, set = TimestampSet();
    // The job's command buffers go to the GPU in one or more queue.submit calls inside DrawNow. The first is
    // given a timestamp before it and the last a timestamp after it, in the same submit: nothing else runs in
    // between.
    const submit = queue.submit;
    const captured = [];
    queue.submit = buffers => { captured.push([ ...buffers ]); };
    let started;
    try
    {
      started = performance.now();
      DrawNow(job);
    }
    finally
    {
      delete queue.submit;
      if (queue.submit !== submit) queue.submit = submit;
    }
    const cpuMs = performance.now() - started;
    const all = captured.flat();
    queue.submit([ TimestampMark(set, 0, false), ...all, TimestampMark(set, 1, true) ]);
    await set.read.mapAsync(GPUMapMode.READ);
    const [ begin, end ] = new BigInt64Array(set.read.getMappedRange().slice(0));
    set.read.unmap();
    timestampPool.push(set);
    return { method, gpuMs: Number(end - begin) / 1e6, cpuMs, submits: captured.length, ticks: [ Number(begin), Number(end) ] };
  }
  if (method === "done")
  {
    const started = performance.now();
    DrawNow(job);
    const cpuMs = performance.now() - started;
    await host.gpu.queue.onSubmittedWorkDone();
    return { method, gpuMs: performance.now() - started, cpuMs };
  }
  const gl = host.gl;
  if (method === "timer-query")
  {
    const ext = host.timerQuery, query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    const started = performance.now();
    try { DrawNow(job); }
    finally { gl.endQuery(ext.TIME_ELAPSED_EXT); }
    const cpuMs = performance.now() - started;
    while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) await new Promise(requestAnimationFrame);
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
    gl.deleteQuery(query);
    return { method, gpuMs: disjoint ? null : ns / 1e6, cpuMs };
  }
  const started = performance.now();
  DrawNow(job);
  const cpuMs = performance.now() - started;
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await nextTask();
  const gpuMs = performance.now() - started;
  gl.deleteSync(sync);
  return { method: "fence", gpuMs, cpuMs };
}

/**
 * Runs `job` once and waits for the GPU before returning: the blocking measure (see the head comment).
 * On WebGPU this is `TimeJob` (WebGPU has no blocking wait).
 *
 * @param {object} job A `TriRenderJob`.
 * @returns {{method: "readback", gpuMs: number, cpuMs: number}|Promise<object>} Wall time of DrawNow plus the GPU's work.
 */
export function TimeJobNow(job)
{
  if (!host) throw new Error("TimeJobNow needs ShatteredBoot to have run");
  if (host.gpu) return TimeJob(job);
  const gl = host.gl;
  const started = performance.now();
  DrawNow(job);
  const cpuMs = performance.now() - started;
  // One pixel of the canvas read back: the browser has to finish every draw before it (gl.finish() alone
  // returns before SwiftShader has rasterised). The read framebuffer is put back as it was.
  const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, host.pixel ??= new Uint8Array(4));
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
  return { method: "readback", gpuMs: performance.now() - started, cpuMs };
}
