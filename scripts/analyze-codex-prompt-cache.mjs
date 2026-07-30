#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return options;
}

function numberOption(options, key, fallback) {
  if (typeof options[key] === "undefined") return fallback;
  const value = Number(options[key]);
  if (!Number.isFinite(value)) fail(`--${key} must be a number`);
  return value;
}

function safeNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * quantile)];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function walkRollouts(root, cutoffMs) {
  const files = [];

  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const stat = await fsp.stat(fullPath);
        if (stat.mtimeMs >= cutoffMs) files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files;
}

async function scanRollout(file, excludedSession) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = "";
  let model = "";
  let previousUsageSignature = "";
  const calls = [];

  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === "session_meta") {
      sessionId =
        typeof row.payload?.id === "string" ? row.payload.id : sessionId;
      continue;
    }

    if (row.type === "turn_context") {
      model =
        typeof row.payload?.model === "string" ? row.payload.model : model;
      continue;
    }

    if (
      row.type !== "event_msg" ||
      row.payload?.type !== "token_count" ||
      !row.payload?.info?.last_token_usage
    ) {
      continue;
    }

    const usage = row.payload.info.last_token_usage;
    const inputTokens = safeNumber(usage.input_tokens);
    if (!inputTokens) continue;
    const call = {
      model: model || "unknown",
      inputTokens,
      cachedTokens: safeNumber(usage.cached_input_tokens),
      cacheWriteTokens: safeNumber(usage.cache_write_input_tokens),
      cachedFieldPresent: Object.hasOwn(usage, "cached_input_tokens"),
      cacheWriteFieldPresent: Object.hasOwn(
        usage,
        "cache_write_input_tokens",
      ),
      outputTokens: safeNumber(usage.output_tokens),
      reasoningTokens: safeNumber(usage.reasoning_output_tokens),
    };
    const usageSignature = JSON.stringify(call);
    if (usageSignature === previousUsageSignature) continue;
    previousUsageSignature = usageSignature;
    calls.push(call);
  }

  return sessionId === excludedSession ? [] : calls;
}

function summarize(calls) {
  const inputTokens = calls.map((call) => call.inputTokens);
  const cacheRatios = calls.map((call) =>
    call.inputTokens > 0 ? call.cachedTokens / call.inputTokens : 0,
  );
  const totalInput = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const totalCached = calls.reduce((sum, call) => sum + call.cachedTokens, 0);
  const totalCacheWrite = calls.reduce(
    (sum, call) => sum + call.cacheWriteTokens,
    0,
  );
  const totalOutput = calls.reduce((sum, call) => sum + call.outputTokens, 0);
  const totalReasoning = calls.reduce(
    (sum, call) => sum + call.reasoningTokens,
    0,
  );
  const uncachedNonWrite = Math.max(
    0,
    totalInput - totalCached - totalCacheWrite,
  );
  const gpt56InputRateEquivalent =
    uncachedNonWrite + totalCached * 0.1 + totalCacheWrite * 1.25;
  const eligibleCalls = calls.filter((call) => call.inputTokens >= 1024);

  return {
    calls: calls.length,
    eligibleCalls: eligibleCalls.length,
    inputTokens: totalInput,
    cachedTokens: totalCached,
    cacheWriteTokens: totalCacheWrite,
    outputTokens: totalOutput,
    reasoningTokens: totalReasoning,
    inputMedian: median(inputTokens),
    inputP95: percentile(inputTokens, 0.95),
    cacheRatioMedian: median(cacheRatios),
    cacheRatioP05: percentile(cacheRatios, 0.05),
    aggregateCacheRatio: totalInput > 0 ? totalCached / totalInput : 0,
    cacheReadCalls: calls.filter((call) => call.cachedTokens > 0).length,
    cacheWriteCalls: calls.filter((call) => call.cacheWriteTokens > 0).length,
    cachedFieldPresentCalls: calls.filter((call) => call.cachedFieldPresent)
      .length,
    cacheWriteFieldPresentCalls: calls.filter(
      (call) => call.cacheWriteFieldPresent,
    ).length,
    eligibleZeroCacheCalls: eligibleCalls.filter(
      (call) => call.cachedTokens === 0,
    ).length,
    gpt56InputRateEquivalent,
    gpt56SavingsVsUncached:
      totalInput > 0 ? 1 - gpt56InputRateEquivalent / totalInput : 0,
  };
}

async function summarizeCorpus(corpusPath) {
  if (!corpusPath) return undefined;
  const corpus = JSON.parse(await fsp.readFile(corpusPath, "utf8"));
  const cases = Array.isArray(corpus?.cases) ? corpus.cases : [];
  let pairsWithFirstCacheableBlock = 0;
  let stableFirstCacheableBlock = 0;
  let firstCacheableBlockIsInFirstItem = 0;
  const firstCacheableTextCharacters = [];

  for (const entry of cases) {
    const first = Array.isArray(entry?.checkpoint1?.fullInput)
      ? entry.checkpoint1.fullInput
      : [];
    const second = Array.isArray(entry?.checkpoint2?.fullInput)
      ? entry.checkpoint2.fullInput
      : [];
    const itemIndex = first.findIndex(
      (item) =>
        Array.isArray(item?.content) &&
        item.content.some((part) =>
          ["input_text", "input_image", "input_file"].includes(part?.type),
        ),
    );
    if (itemIndex < 0) continue;
    pairsWithFirstCacheableBlock += 1;
    if (itemIndex === 0) firstCacheableBlockIsInFirstItem += 1;
    if (
      itemIndex < second.length &&
      JSON.stringify(first[itemIndex]) === JSON.stringify(second[itemIndex])
    ) {
      stableFirstCacheableBlock += 1;
    }
    firstCacheableTextCharacters.push(
      first[itemIndex].content.reduce(
        (sum, part) =>
          sum +
          (part?.type === "input_text" && typeof part.text === "string"
            ? part.text.length
            : 0),
        0,
      ),
    );
  }

  return {
    cases: cases.length,
    checkpointPairs: cases.length,
    pairsWithFirstCacheableBlock,
    stableFirstCacheableBlock,
    firstCacheableBlockIsInFirstItem,
    firstCacheableTextCharactersMedian: median(firstCacheableTextCharacters),
    firstCacheableTextCharactersP95: percentile(
      firstCacheableTextCharacters,
      0.95,
    ),
    firstCacheableTextAtLeast4096Characters: firstCacheableTextCharacters.filter(
      (characters) => characters >= 4096,
    ).length,
    rawContentPersisted: false,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionsDir =
    options["sessions-dir"] ??
    path.join(process.env.HOME ?? "", ".codex", "sessions");
  const days = numberOption(options, "days", 30);
  const excludedSession = String(options["exclude-session"] ?? "");
  const output = options.output ? path.resolve(String(options.output)) : "";
  const corpusPath = options.corpus
    ? path.resolve(String(options.corpus))
    : "";
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = await walkRollouts(sessionsDir, cutoffMs);
  const calls = (
    await Promise.all(
      files.map((file) => scanRollout(file, excludedSession)),
    )
  ).flat();
  const byModel = Object.fromEntries(
    [...new Set(calls.map((call) => call.model))]
      .sort()
      .map((model) => [
        model,
        summarize(calls.filter((call) => call.model === model)),
      ]),
  );
  const gpt56Calls = calls.filter((call) =>
    call.model.toLowerCase().startsWith("gpt-5.6"),
  );
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      type: "local_codex_rollouts",
      horizonDays: days,
      rolloutFiles: files.length,
      excludedCurrentSession: Boolean(excludedSession),
      rawContentPersisted: false,
      sessionIdentifiersPersisted: false,
    },
    corpusStructure: await summarizeCorpus(corpusPath),
    allModels: summarize(calls),
    gpt56: summarize(gpt56Calls),
    byModel,
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, serialized);
  }
  process.stdout.write(serialized);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
