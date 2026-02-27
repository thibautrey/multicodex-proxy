import express from "express";
import { randomUUID } from "node:crypto";
import { AccountStore } from "./store.js";
import { chooseAccount, isQuotaErrorText, markQuotaHit, refreshUsageIfNeeded } from "./quota.js";
import type { Account } from "./types.js";

const PORT = Number(process.env.PORT ?? 4010);
const STORE_PATH = process.env.STORE_PATH ?? "/data/accounts.json";
const CHATGPT_BASE_URL = process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com";
const UPSTREAM_PATH = process.env.UPSTREAM_PATH ?? "/backend-api/codex/responses";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

const app = express();
app.use(express.json({ limit: "10mb" }));

const store = new AccountStore(STORE_PATH);
await store.init();

function adminGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ADMIN_TOKEN) return next();
  const token = req.header("x-admin-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

function redact(a: Account) {
  return {
    ...a,
    accessToken: a.accessToken ? `${a.accessToken.slice(0, 8)}...` : "",
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/admin/accounts", adminGuard, async (_req, res) => {
  const accounts = await store.listAccounts();
  res.json({ accounts: accounts.map(redact) });
});

app.post("/admin/accounts", adminGuard, async (req, res) => {
  const body = req.body ?? {};
  if (!body.accessToken) return res.status(400).json({ error: "accessToken required" });
  const acc: Account = {
    id: body.id ?? randomUUID(),
    email: body.email,
    accessToken: body.accessToken,
    chatgptAccountId: body.chatgptAccountId,
    enabled: body.enabled ?? true,
    priority: body.priority ?? 0,
    usage: body.usage,
    state: body.state,
  };
  await store.upsertAccount(acc);
  res.json({ ok: true, account: redact(acc) });
});

app.patch("/admin/accounts/:id", adminGuard, async (req, res) => {
  const updated = await store.patchAccount(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, account: redact(updated) });
});

app.delete("/admin/accounts/:id", adminGuard, async (req, res) => {
  const ok = await store.deleteAccount(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.post("/admin/accounts/:id/unblock", adminGuard, async (req, res) => {
  const accs = await store.listAccounts();
  const acc = accs.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: "not found" });
  acc.state = { ...acc.state, blockedUntil: undefined, blockedReason: undefined };
  await store.upsertAccount(acc);
  res.json({ ok: true, account: redact(acc) });
});

async function streamOrJson(resUp: Response, res: express.Response) {
  res.status(resUp.status);
  for (const [k, v] of resUp.headers.entries()) {
    if (k.toLowerCase() === "content-length") continue;
    res.setHeader(k, v);
  }
  if (!resUp.body) {
    res.end();
    return;
  }
  const reader = resUp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function proxyWithRotation(req: express.Request, res: express.Response) {
  let accounts = await store.listAccounts();
  if (!accounts.length) return res.status(503).json({ error: "no accounts configured" });

  // refresh usage cache (best-effort)
  accounts = await Promise.all(accounts.map((a) => refreshUsageIfNeeded(a, CHATGPT_BASE_URL)));
  await Promise.all(accounts.map((a) => store.upsertAccount(a)));

  const tried = new Set<string>();

  for (let i = 0; i < accounts.length; i++) {
    const selected = chooseAccount(accounts.filter((a) => !tried.has(a.id)));
    if (!selected) break;
    tried.add(selected.id);

    selected.state = { ...selected.state, lastSelectedAt: Date.now() };
    await store.upsertAccount(selected);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${selected.accessToken}`,
      accept: req.header("accept") ?? "application/json",
    };
    if (selected.chatgptAccountId) headers["ChatGPT-Account-Id"] = selected.chatgptAccountId;

    try {
      const upstream = await fetch(`${CHATGPT_BASE_URL}${UPSTREAM_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(req.body ?? {}),
      });

      if (upstream.ok) return streamOrJson(upstream, res);

      const text = await upstream.text();
      if (upstream.status === 429 || isQuotaErrorText(text)) {
        markQuotaHit(selected, `quota/rate-limit: ${upstream.status}`);
        await store.upsertAccount(selected);
        continue;
      }

      return res.status(upstream.status).type("application/json").send(text);
    } catch (err: any) {
      selected.state = { ...selected.state, lastError: err?.message ?? String(err) };
      await store.upsertAccount(selected);
    }
  }

  res.status(429).json({ error: "all accounts exhausted or unavailable" });
}

app.post("/v1/chat/completions", proxyWithRotation);
app.post("/v1/responses", proxyWithRotation);

app.listen(PORT, () => {
  console.log(`multicodex-proxy listening on :${PORT}`);
  console.log(`store=${STORE_PATH} upstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH}`);
});
