import { spawn } from "node:child_process";
import type express from "express";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ProviderAgentControl } from "./provider-agent-supervisor.js";

const MAXIMUM_UPDATER_OUTPUT_BYTES = 256 * 1024;

export type HostUpdateStatus = {
  schema_version: "multivibe-host-updater-state-v1";
  mode: "automatic" | "download" | "notify";
  channel: "stable" | "beta";
  current_version: string;
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "current" | "deferred" | "failed";
  last_checked_at: string | null;
  next_check_at: string | null;
  available_version: string | null;
  available_critical: boolean;
  rollout_eligible: boolean;
  downloaded: boolean;
  download_requested: boolean;
  install_requested: boolean;
  last_installed_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  container_managed: boolean;
};

type JobRunnerControl = {
  start(): void;
  stop(): void;
  activeCount(): number;
};

function isUpdateStatus(value: unknown): value is HostUpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return status.schema_version === "multivibe-host-updater-state-v1" &&
    ["automatic", "download", "notify"].includes(String(status.mode)) &&
    ["stable", "beta"].includes(String(status.channel)) &&
    typeof status.current_version === "string" &&
    ["idle", "checking", "available", "downloading", "downloaded", "installing", "current", "deferred", "failed"].includes(String(status.status));
}

export class HostUpdateController {
  private draining = false;
  private activeRequests = 0;
  private activeWebsocketTurns = 0;
  private jobRunner?: JobRunnerControl;

  constructor(
    private readonly binaryPath: string | undefined,
    private readonly providerAgent: ProviderAgentControl | undefined,
  ) {
    if (binaryPath && (!path.isAbsolute(binaryPath) || path.normalize(binaryPath) !== binaryPath)) {
      throw new Error("Host updater binary path must be a clean absolute path");
    }
  }

  attachJobRunner(jobRunner: JobRunnerControl) {
    this.jobRunner = jobRunner;
  }

  available() {
    return Boolean(this.binaryPath);
  }

  inferenceMiddleware: express.RequestHandler = (_req, res, next) => {
    if (this.draining) {
      res.setHeader("retry-after", "60");
      return res.status(503).json({
        error: { message: "MultiVibe Host is draining for a verified update", type: "service_unavailable", code: "host_update_draining" },
      });
    }
    this.activeRequests += 1;
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
    res.once("finish", complete);
    res.once("close", complete);
    next();
  };

  admitWebsocket = () => !this.draining;

  websocketTurnStarted = () => {
    this.activeWebsocketTurns += 1;
  };

  websocketTurnFinished = () => {
    this.activeWebsocketTurns = Math.max(0, this.activeWebsocketTurns - 1);
  };

  beginDrain() {
    this.draining = true;
    this.jobRunner?.stop();
  }

  resume() {
    this.draining = false;
    this.jobRunner?.start();
  }

  async readiness() {
    let providerOperation: string | null = null;
    if (this.providerAgent?.enabled) {
      const status = await this.providerAgent.getManagedOllamaStatus();
      providerOperation = status.operation?.trim() || null;
    }
    const activeJobs = this.jobRunner?.activeCount() ?? 0;
    return {
      draining: this.draining,
      ready: this.draining && this.activeRequests === 0 && this.activeWebsocketTurns === 0 && activeJobs === 0 && !providerOperation,
      active_requests: this.activeRequests,
      active_websocket_turns: this.activeWebsocketTurns,
      active_jobs: activeJobs,
      provider_operation: providerOperation,
    };
  }

  private async run(arguments_: string[]): Promise<HostUpdateStatus> {
    if (!this.binaryPath) throw new Error("Host updater is unavailable");
    await access(this.binaryPath);
    return await new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath!, arguments_, { stdio: ["ignore", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      let excessive = false;
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next) > MAXIMUM_UPDATER_OUTPUT_BYTES) {
          excessive = true;
          child.kill("SIGKILL");
        }
        return next;
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (excessive) return reject(new Error("Host updater returned excessive output"));
        if (code !== 0) return reject(new Error(stderr.trim() || `Host updater failed with ${signal ?? `exit ${code}`}`));
        try {
          const status = JSON.parse(stdout);
          if (!isUpdateStatus(status)) throw new Error("Host updater returned invalid status");
          resolve(status);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  status() { return this.run(["status"]); }
  check() { return this.run(["check"]); }
  download() { return this.run(["request-download"]); }
  configure(mode: HostUpdateStatus["mode"], channel: HostUpdateStatus["channel"]) {
    return this.run(["configure", "--mode", mode, "--channel", channel]);
  }

  apply() { return this.run(["request-apply"]); }
}
