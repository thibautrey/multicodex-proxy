import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFromOAuth,
  mergeTokenIntoAccount,
  type TokenResponse,
} from "./oauth.js";
import type { Account, OAuthFlowState } from "./types.js";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function token(overrides: Partial<TokenResponse> = {}): TokenResponse {
  return {
    access_token: "new-access-token",
    account_id: "chatgpt-account-1",
    id_token: jwt({
      sub: "user-1",
      email: "owner@example.com",
      account_id: "chatgpt-account-1",
    }),
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "local-account-1",
    email: "owner@example.com",
    accessToken: "old-access-token",
    chatgptAccountId: "chatgpt-account-1",
    enabled: true,
    ...overrides,
  };
}

test("reauth keeps the stable local identity for the same upstream account", () => {
  const merged = mergeTokenIntoAccount(account(), token());

  assert.equal(merged.id, "local-account-1");
  assert.equal(merged.chatgptAccountId, "chatgpt-account-1");
  assert.equal(merged.accessToken, "new-access-token");
});

test("reauth rejects a token issued for another upstream account", () => {
  assert.throws(
    () =>
      mergeTokenIntoAccount(
        account(),
        token({
          account_id: "chatgpt-account-2",
          id_token: jwt({
            email: "other@example.com",
            account_id: "chatgpt-account-2",
          }),
        }),
      ),
    /OAuth account mismatch/,
  );
});

test("legacy accounts without an upstream id reject a different verified email", () => {
  assert.throws(
    () =>
      mergeTokenIntoAccount(
        account({ chatgptAccountId: undefined }),
        token({
          account_id: undefined,
          id_token: jwt({ email: "other@example.com" }),
        }),
      ),
    /OAuth account mismatch/,
  );
});

test("new OAuth accounts use the upstream account id as their stable id", () => {
  const flow: OAuthFlowState = {
    id: "flow-1",
    email: "owner@example.com",
    codeVerifier: "verifier",
    createdAt: Date.now(),
    status: "pending",
  };

  const created = accountFromOAuth(flow, token());

  assert.equal(created.id, "chatgpt-account-1");
  assert.equal(created.chatgptAccountId, "chatgpt-account-1");
});
