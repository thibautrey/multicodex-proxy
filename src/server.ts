import { createRuntime } from "./runtime.js";

async function main() {
  const runtime = await createRuntime({ installSignalHandlers: true });
  await runtime.start();
  console.log(
    `multivibe listening on ${runtime.config.host}:${runtime.config.port}`,
  );
  console.log(
    `store=${runtime.config.storePath} oauth=${runtime.config.oauthStatePath} trace=${runtime.config.traceFilePath} traceStats=${runtime.config.traceStatsHistoryPath} redirect=${runtime.config.oauthConfig.redirectUri} openaiUpstream=${runtime.config.openaiBaseUrl} mistralUpstream=${runtime.config.mistralBaseUrl}${runtime.config.mistralUpstreamPath}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
