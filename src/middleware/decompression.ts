import { decompress } from "@foxglove/wasm-zstd";
import express from "express";
import { REQUEST_BODY_LIMIT } from "../config.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      originalHeadersForPassthrough?: Record<string, string | string[] | undefined>;
    }
  }
}

function parseByteLimit(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/);
  if (!match) return 100 * 1024 * 1024;

  const amount = Number(match[1]);
  const unit = match[2] ?? "b";
  const multiplier =
    unit === "gb" || unit === "gib"
      ? 1024 * 1024 * 1024
      : unit === "mb" || unit === "mib"
        ? 1024 * 1024
        : unit === "kb" || unit === "kib"
          ? 1024
          : 1;

  return Math.max(1, Math.floor(amount * multiplier));
}

function parseJsonBody(raw: Uint8Array): Record<string, unknown> {
  const str = new TextDecoder().decode(raw);
  try {
    return JSON.parse(str);
  } catch {
    throw new Error("Invalid JSON");
  }
}

export function createBodyParserMiddleware() {
  const jsonParser = express.json({
    limit: REQUEST_BODY_LIMIT,
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = Buffer.from(buf);
    },
  });
  const requestBodyLimitBytes = parseByteLimit(REQUEST_BODY_LIMIT);

  function sendPayloadTooLarge(res: express.Response) {
    if (res.headersSent) return;
    res.status(413).json({
      error: {
        message: `Request body is too large. Limit is ${REQUEST_BODY_LIMIT}.`,
        type: "invalid_request_error",
        code: "payload_too_large",
      },
    });
  }

  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    req.originalHeadersForPassthrough = { ...req.headers };
    const contentEncoding = req.headers["content-encoding"];

    if (!contentEncoding) {
      return jsonParser(req, res, next);
    }

    const encodings = contentEncoding.split(",").map((e: string) => e.trim().toLowerCase());

    if (!encodings.includes("zstd")) {
      return jsonParser(req, res, next);
    }

    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
      return jsonParser(req, res, next);
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let done = false;

    req.on("data", (chunk: Buffer) => {
      if (done) return;
      receivedBytes += chunk.length;
      if (receivedBytes > requestBodyLimitBytes) {
        done = true;
        chunks.length = 0;
        sendPayloadTooLarge(res);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", async () => {
      if (done) return;
      done = true;
      try {
        const rawBody = Buffer.concat(chunks);
        req.rawBody = rawBody;

        let bodyBuffer: Buffer;
        try {
          bodyBuffer = decompress(rawBody, requestBodyLimitBytes);
        } catch {
          res.status(400).json({
            error: {
              message: "Failed to decompress zstd body within the request body limit",
              type: "invalid_request_error",
            },
          });
          return;
        }

        if (bodyBuffer.length > requestBodyLimitBytes) {
          sendPayloadTooLarge(res);
          return;
        }

        try {
          req.body = parseJsonBody(new Uint8Array(bodyBuffer));
        } catch {
          res.status(400).json({
            error: {
              message: "Invalid JSON in decompressed body",
              type: "invalid_request_error",
            },
          });
          return;
        }

        const remainingEncs = encodings.filter((e: string) => e !== "zstd");
        if (remainingEncs.length > 0) {
          req.headers["content-encoding"] = remainingEncs.join(", ");
        } else {
          delete req.headers["content-encoding"];
        }

        next();
      } catch {
        res.status(500).json({
          error: {
            message: "Error processing zstd body",
            type: "internal_error",
          },
        });
      }
    });

    req.on("aborted", () => {
      done = true;
      chunks.length = 0;
    });

    req.on("error", (err) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      next(err);
    });
  };
}
