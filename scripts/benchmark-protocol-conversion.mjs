import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const mode = process.argv.includes("--native") ? "native" : "typescript";
const samplesArgument = process.argv.find((value) => value.startsWith("--samples="));
const samples = Math.max(
  1,
  Number(samplesArgument?.slice("--samples=".length) ?? 2000),
);
const segmentsArgument = process.argv.find((value) => value.startsWith("--segments="));
const segments = Math.max(
  1,
  Number(segmentsArgument?.slice("--segments=".length) ?? 24),
);

if (mode === "typescript") {
  process.env.MULTIVIBE_PROXY_CORE_NATIVE = "off";
} else {
  process.env.MULTIVIBE_PROXY_CORE_PROTOCOL_CONVERSION = "on";
}

const { chatCompletionObjectToResponseObject } = await import(
  new URL("../src/responses/converters.ts", import.meta.url).href
);

const chat = {
  object: "chat.completion",
  id: "chat-benchmark",
  created: 1710000000,
  model: "gpt-benchmark",
  choices: [
    {
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
    },
  ],
  usage: { prompt_tokens: 1800, completion_tokens: 900, total_tokens: 2700 },
};

const timings = [];
for (let index = 0; index < Math.min(200, samples); index += 1) {
  chatCompletionObjectToResponseObject(chat, "fallback-model");
}
for (let index = 0; index < samples; index += 1) {
  const started = performance.now();
  const response = chatCompletionObjectToResponseObject(chat, "fallback-model");
  timings.push(performance.now() - started);
  if (response?.object !== "response") throw new Error("invalid conversion result");
}

timings.sort((left, right) => left - right);
const percentile = (ratio) => timings[Math.min(timings.length - 1, Math.floor(timings.length * ratio))];
console.log(
  JSON.stringify({
    mode,
    samples,
    payloadBytes: Buffer.byteLength(JSON.stringify(chat)),
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    totalMs: timings.reduce((sum, value) => sum + value, 0),
    script: fileURLToPath(import.meta.url),
  }),
);
