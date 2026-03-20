import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

export async function createTempDir(prefix = "multivibe-test-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

export async function startHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, 250);
        server.close((err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

export async function getAvailablePort() {
  const lease = await startHttpServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  const { port } = new URL(lease.url);
  await lease.close();
  return Number(port);
}

export async function startRuntime(options = {}) {
  const { createRuntime } = await import("../dist/runtime.js");
  const callbackPort = await getAvailablePort();
  const runtime = await createRuntime({
    host: "127.0.0.1",
    port: 0,
    adminToken: "test-admin",
    installSignalHandlers: false,
    oauthConfig:
      options.oauthConfig ??
      {
        authorizationUrl: "https://auth.openai.com/oauth/authorize",
        tokenUrl: "https://auth.openai.com/oauth/token",
        clientId: "test-client",
        scope: "openid profile email offline_access",
        redirectUri: `http://127.0.0.1:${callbackPort}/auth/callback`,
      },
    ...options,
  });
  await runtime.start();
  const address = runtime.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    runtime,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      runtime.server.closeIdleConnections();
      runtime.server.closeAllConnections();
      await runtime.shutdown();
    },
  };
}
