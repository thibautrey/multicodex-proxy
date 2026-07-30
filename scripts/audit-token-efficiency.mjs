#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_THRESHOLDS = [64_000, 80_000, 96_000, 112_000, 128_000];
const AUTH_TOPIC_RE =
  /\b(password|passphrase|secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization:\s*bearer|private key)\b/i;
const HIGH_RISK_RE =
  /authorization\s*:\s*bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passphrase|secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\s*(?::|=|\bis\b|\best\b)\s*["']?[a-z0-9._/+:-]{6,}|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|eyJ[a-z0-9_-]{12,}\.[a-z0-9_-]{12,}/i;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return { command, options };
}

function numberOption(options, key, fallback) {
  if (typeof options[key] === "undefined") return fallback;
  const value = Number(options[key]);
  if (!Number.isFinite(value)) fail(`--${key} must be a number`);
  return value;
}

function hashId(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * quantile)];
}

function asText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text ?? part?.output_text ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function redactAuthenticationText(value) {
  return String(value).replace(
    new RegExp(HIGH_RISK_RE.source, "gi"),
    "[REDACTED_AUTH]",
  );
}

function sanitizeMessage(payload) {
  if (!payload || payload.type !== "message") return null;
  if (!["user", "developer", "system", "assistant"].includes(payload.role)) {
    return null;
  }
  const text = redactAuthenticationText(asText(payload.content));
  if (!text.trim()) return null;
  const contentType = payload.role === "assistant" ? "output_text" : "input_text";
  const message = {
    type: "message",
    role: payload.role,
    content: [{ type: contentType, text }],
  };
  if (
    payload.role === "assistant" &&
    (payload.phase === "commentary" || payload.phase === "final_answer")
  ) {
    message.phase = payload.phase;
  }
  return message;
}

function sanitizeResponseItem(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.type === "message") return sanitizeMessage(payload);
  if (payload.type === "function_call") {
    if (!payload.call_id || !payload.name) return null;
    return {
      type: "function_call",
      call_id: String(payload.call_id),
      name: String(payload.name),
      arguments:
        typeof payload.arguments === "string"
          ? redactAuthenticationText(payload.arguments)
          : redactAuthenticationText(JSON.stringify(payload.arguments ?? {})),
    };
  }
  if (payload.type === "function_call_output") {
    if (!payload.call_id) return null;
    return {
      type: "function_call_output",
      call_id: String(payload.call_id),
      output:
        typeof payload.output === "string"
          ? redactAuthenticationText(payload.output)
          : redactAuthenticationText(JSON.stringify(payload.output ?? "")),
    };
  }
  if (payload.type === "custom_tool_call") {
    if (!payload.call_id || !payload.name) return null;
    return {
      type: "custom_tool_call",
      call_id: String(payload.call_id),
      name: String(payload.name),
      input:
        typeof payload.input === "string"
          ? redactAuthenticationText(payload.input)
          : redactAuthenticationText(JSON.stringify(payload.input ?? {})),
    };
  }
  if (payload.type === "custom_tool_call_output") {
    if (!payload.call_id) return null;
    return {
      type: "custom_tool_call_output",
      call_id: String(payload.call_id),
      output:
        typeof payload.output === "string"
          ? redactAuthenticationText(payload.output)
          : redactAuthenticationText(JSON.stringify(payload.output ?? "")),
    };
  }
  return null;
}

async function walkRollouts(root, cutoffMs) {
  const files = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs >= cutoffMs) files.push({ file: full, stat });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

async function scanSession(file, { collectItems = false } = {}) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId;
  let cwd;
  let sanitizedCount = 0;
  let toolCount = 0;
  let compactedCount = 0;
  let previousInputTokens = 0;
  let previousUsage = null;
  let windowNumber = 0;
  let highRisk = false;
  const checkpoints = [];
  let items = [];
  const compactionRatios = [];
  const openToolCalls = new Map();
  let unmatchedToolOutputs = 0;

  function trackToolBalance(item) {
    if (
      item?.type === "function_call" ||
      item?.type === "custom_tool_call"
    ) {
      openToolCalls.set(item.call_id, item.type);
    } else if (
      item?.type === "function_call_output" ||
      item?.type === "custom_tool_call_output"
    ) {
      if (!openToolCalls.delete(item.call_id)) unmatchedToolOutputs += 1;
    }
  }

  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === "session_meta") {
      sessionId = row.payload?.id;
      cwd = row.payload?.cwd;
      continue;
    }

    if (row.type === "compacted") {
      compactedCount += 1;
      windowNumber += 1;
      const replacementHistory = Array.isArray(row.payload?.replacement_history)
        ? row.payload.replacement_history
        : [];
      const replacementItems = replacementHistory
        .map((item) => sanitizeResponseItem(item))
        .filter(Boolean);
      const rendered = JSON.stringify(replacementHistory);
      const estimatedTokens = Math.max(1, Math.ceil(rendered.length / 4));
      if (previousInputTokens > 0) {
        compactionRatios.push(
          Math.min(0.9, estimatedTokens / previousInputTokens),
        );
      }
      sanitizedCount = replacementItems.length;
      if (collectItems) items = replacementItems;
      openToolCalls.clear();
      unmatchedToolOutputs = 0;
      for (const item of replacementItems) trackToolBalance(item);
      continue;
    }

    if (row.type === "event_msg" && row.payload?.type === "token_count") {
      const usage = row.payload?.info?.last_token_usage;
      const inputTokens = Number(usage?.input_tokens ?? 0);
      if (inputTokens > 0) {
        previousInputTokens = inputTokens;
        previousUsage = usage;
      }
      continue;
    }

    if (row.type !== "response_item") continue;
    const payload = row.payload;
    if (
      payload?.type === "message" &&
      (payload.role === "user" || payload.role === "developer") &&
      AUTH_TOPIC_RE.test(asText(payload.content))
    ) {
      highRisk = true;
    }
    if (
      payload?.type === "function_call" ||
      payload?.type === "custom_tool_call"
    ) {
      toolCount += 1;
    }

    const item = sanitizeResponseItem(payload);
    if (!item) continue;

    if (
      payload.type === "message" &&
      payload.role === "assistant" &&
      payload.phase === "final_answer"
    ) {
      checkpoints.push({
        contextLength: sanitizedCount,
        referenceText: redactAuthenticationText(asText(payload.content)),
        inputTokens: Number(previousUsage?.input_tokens ?? 0),
        outputTokens: Number(previousUsage?.output_tokens ?? 0),
        reasoningTokens: Number(
          previousUsage?.reasoning_output_tokens ?? 0,
        ),
        ordinal: checkpoints.length,
        windowNumber,
        openToolCalls: openToolCalls.size,
        unmatchedToolOutputs,
        inputSnapshot: collectItems ? [...items] : undefined,
      });
    }

    if (collectItems) items.push(item);
    trackToolBalance(item);
    sanitizedCount += 1;
  }

  return {
    file,
    sessionId,
    cwd,
    highRisk,
    toolCount,
    compactedCount,
    checkpoints: checkpoints.filter(
      (checkpoint) =>
        checkpoint.inputTokens > 0 && checkpoint.referenceText.trim().length > 0,
    ),
    items,
    compactionRatios,
  };
}

function bucketFor(tokens) {
  if (tokens >= 64_000 && tokens < 96_000) return "64k-96k";
  if (tokens >= 96_000 && tokens < 128_000) return "96k-128k";
  if (tokens >= 128_000) return "128k+";
  return null;
}

function caseOptions(session) {
  const options = [];
  for (let index = 0; index < session.checkpoints.length - 1; index += 1) {
    const first = session.checkpoints[index];
    const second = session.checkpoints[index + 1];
    if (first.windowNumber !== second.windowNumber) continue;
    if (first.openToolCalls !== 0 || second.openToolCalls !== 0) continue;
    if (
      first.unmatchedToolOutputs !== 0 ||
      second.unmatchedToolOutputs !== 0
    ) {
      continue;
    }
    const bucket = bucketFor(first.inputTokens);
    if (!bucket) continue;
    options.push({ session, first, second, index, bucket });
  }
  return options;
}

function selectCases(sessions, { allowBackfill = false } = {}) {
  const targets = new Map([
    ["64k-96k", 4],
    ["96k-128k", 4],
    ["128k+", 2],
  ]);
  const options = sessions
    .flatMap(caseOptions)
    .sort((a, b) => {
      const heavyDelta = Number(b.session.toolCount >= 10) - Number(a.session.toolCount >= 10);
      if (heavyDelta) return heavyDelta;
      return b.session.toolCount - a.session.toolCount;
    });
  const selected = [];
  const usedSessions = new Set();

  for (const [bucket, target] of targets) {
    for (const option of options) {
      if (selected.filter((entry) => entry.bucket === bucket).length >= target) break;
      if (option.bucket !== bucket || usedSessions.has(option.session.file)) continue;
      selected.push(option);
      usedSessions.add(option.session.file);
    }
  }

  if (allowBackfill && selected.length < 10) {
    for (const option of options) {
      if (selected.length >= 10) break;
      if (usedSessions.has(option.session.file)) continue;
      selected.push(option);
      usedSessions.add(option.session.file);
    }
  }

  return selected;
}

function corpusDistribution(cases) {
  return Object.fromEntries(
    ["64k-96k", "96k-128k", "128k+"].map((bucket) => [
      bucket,
      cases.filter((entry) => entry.bucket === bucket).length,
    ]),
  );
}

function hasRequiredDistribution(cases) {
  const distribution = corpusDistribution(cases);
  return (
    distribution["64k-96k"] === 4 &&
    distribution["96k-128k"] === 4 &&
    distribution["128k+"] === 2
  );
}

function simulateThresholds(sessions, compactRatio) {
  return DEFAULT_THRESHOLDS.map((threshold) => {
    let calls = 0;
    let compactions = 0;
    let projectedBaseline = 0;
    let projectedCandidate = 0;
    let positiveTwoTurnWindows = 0;
    let eligibleWindows = 0;

    for (const session of sessions) {
      const checkpoints = session.checkpoints;
      let simulatedContext = checkpoints[0]?.inputTokens ?? 0;
      for (let index = 0; index < checkpoints.length; index += 1) {
        const current = checkpoints[index];
        calls += 1;
        if (simulatedContext >= threshold) {
          compactions += 1;
          simulatedContext *= compactRatio;
        }
        const next = checkpoints[index + 1];
        if (current.inputTokens >= threshold && next) {
          const growth = Math.max(0, next.inputTokens - current.inputTokens);
          const compacted = current.inputTokens * compactRatio;
          const baseline = current.inputTokens + next.inputTokens;
          const candidate =
            current.inputTokens + compacted + (compacted + growth);
          projectedBaseline += baseline;
          projectedCandidate += candidate;
          eligibleWindows += 1;
          if (candidate < baseline) positiveTwoTurnWindows += 1;
        }
        const growth = next
          ? Math.max(0, next.inputTokens - current.inputTokens)
          : 0;
        simulatedContext += growth;
      }
    }

    const callsPerCompaction = compactions ? calls / compactions : Infinity;
    const savings =
      projectedBaseline > 0
        ? 1 - projectedCandidate / projectedBaseline
        : 0;
    return {
      threshold,
      calls,
      compactions,
      callsPerCompaction,
      eligibleWindows,
      positiveTwoTurnWindows,
      projectedSavingsRatio: savings,
      eligible:
        callsPerCompaction >= 8 &&
        eligibleWindows > 0 &&
        positiveTwoTurnWindows === eligibleWindows &&
        savings > 0,
    };
  });
}

function chooseThreshold(simulations) {
  const eligible = simulations.filter((entry) => entry.eligible);
  if (!eligible.length) return null;
  return [...eligible].sort(
    (a, b) =>
      b.projectedSavingsRatio - a.projectedSavingsRatio ||
      b.callsPerCompaction - a.callsPerCompaction,
  )[0];
}

async function buildCorpus(options) {
  const sessionsDir =
    options["sessions-dir"] ?? path.join(process.env.HOME ?? "", ".codex/sessions");
  const output = options.output;
  const manifestPath = options.manifest;
  if (!output || !manifestPath) {
    fail("corpus requires --output and --manifest");
  }
  const excludeSession = String(options["exclude-session"] ?? "");
  const now = Date.now();
  let days = 30;
  let scanned = [];
  let selected = [];
  let distributionTargetMet = false;

  for (const horizon of [30, 90]) {
    days = horizon;
    const files = await walkRollouts(
      sessionsDir,
      now - horizon * 24 * 60 * 60 * 1000,
    );
    scanned = [];
    for (const entry of files) {
      if (entry.stat.size > 80 * 1024 * 1024) continue;
      const session = await scanSession(entry.file);
      if (
        !session.sessionId ||
        session.sessionId === excludeSession ||
        session.highRisk ||
        session.checkpoints.length < 2
      ) {
        continue;
      }
      scanned.push(session);
    }
    selected = selectCases(scanned);
    distributionTargetMet = hasRequiredDistribution(selected);
    if (distributionTargetMet) break;
  }

  if (!distributionTargetMet) {
    selected = selectCases(scanned, { allowBackfill: true });
  }
  if (selected.length < 10) {
    fail(
      `Only ${selected.length} eligible sessions were available after 90 days: ${JSON.stringify(
        corpusDistribution(selected),
      )}`,
    );
  }

  const observedRatios = scanned.flatMap((session) => session.compactionRatios);
  const compactRatio = Math.min(
    0.35,
    Math.max(0.05, median(observedRatios) || 0.12),
  );
  const simulations = simulateThresholds(scanned, compactRatio);
  const chosenThreshold = chooseThreshold(simulations);

  const cases = [];
  for (const option of selected) {
    const full = await scanSession(option.session.file, { collectItems: true });
    const first = full.checkpoints[option.index];
    const second = full.checkpoints[option.index + 1];
    if (
      !Array.isArray(first.inputSnapshot) ||
      !Array.isArray(second.inputSnapshot)
    ) {
      fail(`Missing checkpoint snapshots for ${full.sessionId}`);
    }
    const caseId = hashId(
      `${full.sessionId}:${path.basename(option.session.file)}:${option.index}:20260730`,
    );
    cases.push({
      caseId,
      bucket: option.bucket,
      toolCount: full.toolCount,
      hadPriorCompaction: full.compactedCount > 0,
      compactInput: first.inputSnapshot,
      checkpoint1: {
        fullInput: first.inputSnapshot,
        incrementalInput: [],
        reference: first.referenceText,
        observedInputTokens: first.inputTokens,
      },
      checkpoint2: {
        fullInput: second.inputSnapshot,
        incrementalInput: second.inputSnapshot.slice(first.contextLength),
        reference: second.referenceText,
        observedInputTokens: second.inputTokens,
      },
    });
  }

  const corpus = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    selectionHorizonDays: days,
    distribution: corpusDistribution(cases),
    distributionTargetMet,
    compactRatioEstimate: compactRatio,
    chosenThreshold: chosenThreshold?.threshold ?? null,
    thresholdSimulations: simulations,
    cases,
  };
  const manifest = {
    schemaVersion: 1,
    generatedAt: corpus.generatedAt,
    status: "corpus_ready",
    source: {
      type: "local_codex_rollouts",
      selectionHorizonDays: days,
      scannedEligibleSessions: scanned.length,
      selectedCases: cases.length,
      distribution: corpus.distribution,
      distributionTargetMet,
      rawContentCommitted: false,
    },
    compactRatioEstimate: compactRatio,
    chosenThreshold: corpus.chosenThreshold,
    thresholdSimulations: simulations,
    cases: cases.map((entry) => ({
      caseId: entry.caseId,
      bucket: entry.bucket,
      toolCount: entry.toolCount,
      hadPriorCompaction: entry.hadPriorCompaction,
      checkpoints: [
        entry.checkpoint1.observedInputTokens,
        entry.checkpoint2.observedInputTokens,
      ],
      compactInputItems: entry.compactInput.length,
    })),
  };

  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, `${JSON.stringify(corpus)}\n`, { mode: 0o600 });
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

function usageMetrics(usage) {
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const details =
    usage?.input_tokens_details ?? usage?.prompt_tokens_details ?? {};
  return {
    inputTokens: input,
    cachedTokens: Number(details.cached_tokens ?? 0),
    cacheWriteTokens: Number(details.cache_write_tokens ?? 0),
    outputTokens: output,
    reasoningTokens: Number(
      usage?.output_tokens_details?.reasoning_tokens ??
        usage?.completion_tokens_details?.reasoning_tokens ??
        0,
    ),
    rawTokens: input + output,
  };
}

function responseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const output = Array.isArray(response?.output) ? response.output : [];
  return output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text ?? "")
    .filter(Boolean)
    .join("");
}

async function postJson(baseUrl, route, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      fail(
        `${route} returned ${response.status}: ${text.slice(0, 500) || "empty body"}`,
      );
    }
    if (!parsed) fail(`${route} returned non-JSON content`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function generationPayload(model, input, cacheKey) {
  return {
    model,
    input,
    store: false,
    stream: false,
    prompt_cache_key: cacheKey,
    reasoning: { effort: "low", summary: "auto" },
    text: { verbosity: "medium" },
  };
}

function stableOrder(caseId, checkpoint) {
  const digest = crypto
    .createHash("sha256")
    .update(`20260730:${caseId}:${checkpoint}`)
    .digest();
  return digest[0] % 2 === 0 ? "baseline_first" : "candidate_first";
}

function judgePrompt(caseEntry, outputs) {
  const checkpoints = [1, 2].map((checkpoint) => {
    const order = stableOrder(caseEntry.caseId, checkpoint);
    const baseline = outputs[`baseline${checkpoint}`].text;
    const candidate = outputs[`candidate${checkpoint}`].text;
    return {
      checkpoint,
      reference: caseEntry[`checkpoint${checkpoint}`].reference,
      A: order === "baseline_first" ? baseline : candidate,
      B: order === "baseline_first" ? candidate : baseline,
      order,
    };
  });
  return [
    "Evaluate whether A and B preserve the correctness, completeness, and actionability of the reference final answer.",
    "Score each answer from 0 to 4. Mark critical_error when an answer invents a consequential fact, omits a required safety constraint, or gives an unusable result.",
    "Return JSON only with this shape:",
    '{"checkpoints":[{"checkpoint":1,"A":{"score":0,"critical_error":false},"B":{"score":0,"critical_error":false},"preferred":"A|B|tie"},{"checkpoint":2,"A":{"score":0,"critical_error":false},"B":{"score":0,"critical_error":false},"preferred":"A|B|tie"}]}',
    JSON.stringify(
      checkpoints.map(({ checkpoint, reference, A, B }) => ({
        checkpoint,
        reference,
        A,
        B,
      })),
    ),
  ].join("\n\n");
}

function parseJudge(response, caseEntry) {
  const text = responseText(response).trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) fail(`Judge did not return JSON for ${caseEntry.caseId}`);
  const parsed = JSON.parse(match[0]);
  const checkpoints = Array.isArray(parsed?.checkpoints)
    ? parsed.checkpoints
    : [];
  return checkpoints.map((entry) => {
    const order = stableOrder(caseEntry.caseId, entry.checkpoint);
    const baseline = order === "baseline_first" ? entry.A : entry.B;
    const candidate = order === "baseline_first" ? entry.B : entry.A;
    return {
      checkpoint: entry.checkpoint,
      baselineScore: Number(baseline?.score ?? 0),
      candidateScore: Number(candidate?.score ?? 0),
      baselineCriticalError: Boolean(baseline?.critical_error),
      candidateCriticalError: Boolean(candidate?.critical_error),
      introducedCriticalError:
        Boolean(candidate?.critical_error) && !Boolean(baseline?.critical_error),
      qualityDelta:
        Number(candidate?.score ?? 0) - Number(baseline?.score ?? 0),
      preferred:
        entry.preferred === "tie"
          ? "tie"
          : (order === "baseline_first" && entry.preferred === "A") ||
              (order === "candidate_first" && entry.preferred === "B")
            ? "baseline"
            : "candidate",
    };
  });
}

function sumRaw(entries) {
  return entries.reduce((total, entry) => total + entry.metrics.rawTokens, 0);
}

async function runBenchmark(options) {
  const corpusPath = options.corpus;
  const aggregatePath = options.aggregate;
  const rawOutput = options["raw-output"];
  if (!corpusPath || !aggregatePath || !rawOutput) {
    fail("benchmark requires --corpus, --aggregate, and --raw-output");
  }
  const baseUrl = String(options["base-url"] ?? "http://127.0.0.1:1456").replace(
    /\/+$/,
    "",
  );
  const model = String(options.model ?? "gpt-5.6-sol");
  const maxCalls = numberOption(options, "max-calls", 60);
  const caseLimit = numberOption(options, "case-limit", 10);
  const caseOffset = numberOption(options, "case-offset", 0);
  const startingCallCount = numberOption(options, "starting-call-count", 0);
  const timeoutMs = numberOption(options, "timeout-ms", 600_000);
  const corpus = JSON.parse(await fsp.readFile(corpusPath, "utf8"));
  const cases = corpus.cases.slice(caseOffset, caseOffset + caseLimit);
  const resumeRaw = options["resume-raw"];
  const rawResults = resumeRaw
    ? JSON.parse(await fsp.readFile(resumeRaw, "utf8"))
    : [];
  for (const result of rawResults) {
    const caseEntry = cases.find((entry) => entry.caseId === result.caseId);
    if (!caseEntry) fail(`Resume data contains unknown case ${result.caseId}`);
    result.quality = parseJudge(
      { output_text: result.judge?.text ?? "" },
      caseEntry,
    );
  }
  let callsUsed = startingCallCount + rawResults.length * 6;
  let earlyStopReason = null;

  async function call(route, body) {
    if (callsUsed >= maxCalls) fail(`Call budget exhausted at ${maxCalls}`);
    callsUsed += 1;
    process.stderr.write(`[${callsUsed}/${maxCalls}] ${route}\n`);
    return postJson(baseUrl, route, body, timeoutMs);
  }

  for (const caseEntry of cases.slice(rawResults.length)) {
    const cacheKey = `token-audit:${caseEntry.caseId}`;
    const compact = await call("/v1/responses/compact", {
      model,
      input: caseEntry.compactInput,
    });
    const compactedOutput = Array.isArray(compact?.output)
      ? compact.output
      : null;
    if (!compactedOutput?.length) {
      fail(`Compaction returned no canonical output for ${caseEntry.caseId}`);
    }

    const outputs = {};
    for (const checkpoint of [1, 2]) {
      const checkpointData = caseEntry[`checkpoint${checkpoint}`];
      const candidateInput = [
        ...compactedOutput,
        ...checkpointData.incrementalInput,
      ];
      const requests = {
        baseline: () =>
          call(
            "/v1/responses",
            generationPayload(
              model,
              checkpointData.fullInput,
              `${cacheKey}:baseline:${checkpoint}`,
            ),
          ),
        candidate: () =>
          call(
            "/v1/responses",
            generationPayload(
              model,
              candidateInput,
              `${cacheKey}:candidate:${checkpoint}`,
            ),
          ),
      };
      const order =
        stableOrder(caseEntry.caseId, checkpoint) === "baseline_first"
          ? ["baseline", "candidate"]
          : ["candidate", "baseline"];
      const responses = {};
      for (const variant of order) {
        responses[variant] = await requests[variant]();
      }
      const baselineResponse = responses.baseline;
      const candidateResponse = responses.candidate;
      outputs[`baseline${checkpoint}`] = {
        text: responseText(baselineResponse),
        metrics: usageMetrics(baselineResponse.usage),
      };
      outputs[`candidate${checkpoint}`] = {
        text: responseText(candidateResponse),
        metrics: usageMetrics(candidateResponse.usage),
      };
      if (!outputs[`baseline${checkpoint}`].text.trim()) {
        fail(`Empty baseline output for ${caseEntry.caseId}/${checkpoint}`);
      }
      if (!outputs[`candidate${checkpoint}`].text.trim()) {
        fail(`Empty candidate output for ${caseEntry.caseId}/${checkpoint}`);
      }
    }

    const judgeResponse = await call(
      "/v1/responses",
      generationPayload(
        model,
        [
          {
            role: "user",
            content: [{ type: "input_text", text: judgePrompt(caseEntry, outputs) }],
          },
        ],
        `${cacheKey}:judge`,
      ),
    );
    const quality = parseJudge(judgeResponse, caseEntry);
    const compactMetrics = usageMetrics(compact.usage);
    const baselineRaw = sumRaw([
      outputs.baseline1,
      outputs.baseline2,
    ]);
    const candidateRaw =
      compactMetrics.rawTokens +
      sumRaw([outputs.candidate1, outputs.candidate2]);
    rawResults.push({
      caseId: caseEntry.caseId,
      bucket: caseEntry.bucket,
      compact,
      outputs,
      judge: {
        text: responseText(judgeResponse),
        metrics: usageMetrics(judgeResponse.usage),
      },
      compactMetrics,
      baselineRaw,
      candidateRaw,
      savingsRatio:
        baselineRaw > 0 ? 1 - candidateRaw / baselineRaw : 0,
      quality,
    });

    if (rawResults.length === 3) {
      const firstThreeQuality = rawResults.flatMap((entry) => entry.quality);
      const critical = firstThreeQuality.some(
        (entry) => entry.introducedCriticalError,
      );
      const severeDrop = firstThreeQuality.some(
        (entry) => entry.qualityDelta < -1,
      );
      if (critical || severeDrop) {
        earlyStopReason = critical
          ? "critical_quality_error_in_first_three_cases"
          : "quality_drop_greater_than_one_in_first_three_cases";
        break;
      }
    }
  }

  const safeCases = rawResults.map((entry) => ({
    caseId: entry.caseId,
    bucket: entry.bucket,
    baselineRawTokens: entry.baselineRaw,
    candidateRawTokens: entry.candidateRaw,
    compactRawTokens: entry.compactMetrics.rawTokens,
    savingsRatio: entry.savingsRatio,
    quality: entry.quality,
    tokenDetails: {
      baseline: [entry.outputs.baseline1.metrics, entry.outputs.baseline2.metrics],
      candidate: [
        entry.outputs.candidate1.metrics,
        entry.outputs.candidate2.metrics,
      ],
      compact: entry.compactMetrics,
      judge: entry.judge.metrics,
    },
  }));
  const qualityRows = safeCases.flatMap((entry) => entry.quality);
  const savings = safeCases.map((entry) => entry.savingsRatio);
  const positiveCases = safeCases.filter((entry) => entry.savingsRatio > 0).length;
  const criticalErrors = qualityRows.filter(
    (entry) => entry.introducedCriticalError,
  ).length;
  const equivalentOrBetter = qualityRows.filter(
    (entry) => entry.qualityDelta >= 0,
  ).length;
  const meanQualityDelta = qualityRows.length
    ? qualityRows.reduce((total, entry) => total + entry.qualityDelta, 0) /
      qualityRows.length
    : 0;
  const criteria = {
    medianSavingsAtLeast20Percent: median(savings) >= 0.2,
    positiveInAtLeastEightCases: positiveCases >= 8,
    noCriticalErrors: criticalErrors === 0,
    equivalentOrBetterAtLeast90Percent:
      qualityRows.length > 0 &&
      equivalentOrBetter / qualityRows.length >= 0.9,
    meanQualityDropAtMostPoint25: meanQualityDelta >= -0.25,
  };
  const completedAllCases = rawResults.length === cases.length;
  const recommendation =
    completedAllCases &&
    Object.values(criteria).every(Boolean)
      ? "recommend_opt_in_server_side_compaction"
      : "do_not_enable_automatic_compaction";
  const aggregate = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: earlyStopReason
      ? "stopped_early"
      : completedAllCases
        ? "completed"
        : "incomplete",
    earlyStopReason,
    model,
    callsUsed,
    maxCalls,
    discardedHarnessCalls: startingCallCount,
    chosenThreshold: corpus.chosenThreshold,
    source: {
      type: "local_codex_rollouts",
      selectedCases: cases.length,
      completedCases: rawResults.length,
      corpusDistribution: corpusDistribution(corpus.cases),
      benchmarkDistribution: corpusDistribution(rawResults),
      distributionTargetMet: hasRequiredDistribution(corpus.cases),
      rawContentCommitted: false,
    },
    totals: {
      medianSavingsRatio: median(savings),
      p10SavingsRatio: percentile(savings, 0.1),
      p90SavingsRatio: percentile(savings, 0.9),
      positiveCases,
      checkpointsJudged: qualityRows.length,
      equivalentOrBetter,
      criticalErrors,
      meanQualityDelta,
    },
    criteria,
    recommendation,
    thresholdSimulations: corpus.thresholdSimulations,
    cases: safeCases,
  };

  await fsp.writeFile(rawOutput, `${JSON.stringify(rawResults)}\n`, {
    mode: 0o600,
  });
  await fsp.writeFile(
    aggregatePath,
    `${JSON.stringify(aggregate, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "corpus") {
    await buildCorpus(options);
    return;
  }
  if (command === "benchmark") {
    await runBenchmark(options);
    return;
  }
  fail(
    "Usage: audit-token-efficiency.mjs corpus|benchmark [options]",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
