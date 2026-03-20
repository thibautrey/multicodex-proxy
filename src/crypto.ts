import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type Envelope = {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptJson<T>(value: T, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: Envelope = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope, null, 2);
}

export function decryptJson<T>(raw: string, secret: string): T {
  const parsed = JSON.parse(raw) as Envelope;
  if (!parsed || parsed.v !== 1 || parsed.alg !== "aes-256-gcm") {
    throw new Error("unsupported encrypted payload");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret),
    Buffer.from(parsed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

export function looksEncryptedJson(raw: string): boolean {
  return /^\s*\{\s*"v"\s*:\s*1\s*,\s*"alg"\s*:\s*"aes-256-gcm"/.test(raw);
}
