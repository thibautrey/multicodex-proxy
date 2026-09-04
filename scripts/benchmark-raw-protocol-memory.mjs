import { performance } from "node:perf_hooks";

const modeArgument = process.argv.find((value) => value.startsWith("--mode="));
const mode = modeArgument?.slice("--mode=".length) ?? "native";
if (mode !== "native" && mode !== "typescript") {
  throw new Error(`Unsupported mode: ${mode}`);
}

const numberArgument = (name, fallback) => {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  const parsed = Number(argument?.slice(name.length + 3) ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const samples = numberArgument("samples", 1000);
const inFlight = numberArgument("in-flight", 32);
const segments = numberArgument("segments", 256);
const stream = process.argv.includes("--stream");

process.env.MULTIVIBE_PROXY_CORE_NATIVE = "on";
process.env.MULTIVIBE_PROXY_CORE_PROTOCOL_CONVERSION = mode === "native" ? "on" : "off";

const {
  chatCompletionJsonBytesToResponseBytes,
  chatCompletionObjectToResponseObject,
  responseObjectToSSE,
} = await import(new URL("../src/responses/converters.ts", import.meta.url).href);

const chat = {
  object: "chat.completion",
  id: "memory-benchmark",
  created: 1710000000,
  model: "gpt-memory-benchmark",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: Array.from({ length: segments }, (_, index) => ({
        type: "text",
        text: `Generated output segment ${index}: ${"x".repeat(160)}`,
      })),
      tool_calls: Array.from({ length: 4 }, (_, index) => ({
        id: `call-${index}`,
        type: "function",
        function: {
          name: `tool_${index}`,
          arguments: JSON.stringify({
            index,
            values: Array.from({ length: Math.max(16, Math.floor(segments / 2)) }, (_, value) => value),
          }),
        },
      })),
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 1800, completion_tokens: 900, total_tokens: 2700 },
};
const raw = Buffer.from(JSON.stringify(chat));

const snapshot = () => {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
};

const subtract = (left, right) => Object.fromEntries(
  Object.keys(left).map((key) => [key, left[key] - right[key]]),
);

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const forceGc = async () => {
  if (typeof globalThis.gc !== "function") return;
  for (let index = 0; index < 5; index += 1) {
    globalThis.gc();
    await yieldToEventLoop();
  }
};

const convert = () => {
  if (mode === "native") {
    const result = chatCompletionJsonBytesToResponseBytes(raw, "fallback-model", stream);
    if (!result?.body?.length) throw new Error("native conversion returned no body");
    return result;
  }

  const text = raw.toString("utf8");
  const parsed = JSON.parse(text);
  const response = chatCompletionObjectToResponseObject(parsed, "fallback-model");
  const body = Buffer.from(stream ? responseObjectToSSE(response) : JSON.stringify(response));
  if (!body.length) throw new Error("TypeScript conversion returned no body");
  return { text, parsed, response, body };
};

for (let index = 0; index < Math.min(100, samples); index += 1) convert();
await forceGc();

const before = snapshot();
let peak = before;
const started = performance.now();
let completed = 0;
while (completed < samples) {
  const batch = [];
  const batchSize = Math.min(inFlight, samples - completed);
  for (let index = 0; index < batchSize; index += 1) batch.push(convert());
  completed += batchSize;
  const current = snapshot();
  if (current.rss > peak.rss) peak = current;
  batch.length = 0;
  await yieldToEventLoop();
}
const elapsedMs = performance.now() - started;
const after = snapshot();
await forceGc();
const afterGc = snapshot();

console.log(JSON.stringify({
  mode,
  stream,
  samples,
  inFlight,
  segments,
  payloadBytes: raw.length,
  elapsedMs,
  averageConversionMs: elapsedMs / samples,
  gcAvailable: typeof globalThis.gc === "function",
  before,
  peak,
  after,
  afterGc,
  peakDelta: subtract(peak, before),
  retainedDeltaAfterGc: subtract(afterGc, before),
}));
