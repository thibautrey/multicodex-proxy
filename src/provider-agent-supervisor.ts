import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export type ProviderAgentSupervisor = { stop(): Promise<void> };

export function startEmbeddedProviderAgent(options: {
  enabled: boolean;
  binaryPath: string;
  environment?: NodeJS.ProcessEnv;
  restartLimit?: number;
}): ProviderAgentSupervisor {
  if (!options.enabled) return { stop: async () => undefined };
  if (!path.isAbsolute(options.binaryPath)) throw new Error("provider agent binary path must be absolute");
  let child: ChildProcess | undefined;
  let stopped = false;
  let restarts = 0;
  const restartLimit = options.restartLimit ?? 5;
  const launch = () => {
    if (stopped) return;
    child = spawn(options.binaryPath, [], {
      env: options.environment ?? process.env,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("exit", () => {
      child = undefined;
      if (!stopped && restarts < restartLimit) {
        restarts += 1;
        setTimeout(launch, Math.min(1_000 * restarts, 5_000)).unref();
      }
    });
  };
  launch();
  return {
    stop: async () => {
      stopped = true;
      const running = child;
      if (!running || running.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { running.kill("SIGKILL"); resolve(); }, 5_000);
        timeout.unref();
        running.once("exit", () => { clearTimeout(timeout); resolve(); });
        running.kill("SIGTERM");
      });
    },
  };
}
