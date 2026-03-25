import { decompress } from "@foxglove/wasm-zstd";
import express from "express";

function parseJsonBody(raw: Uint8Array): Record<string, unknown> {
  const str = new TextDecoder().decode(raw);
  try {
    return JSON.parse(str);
  } catch {
    throw new Error("Invalid JSON");
  }
}

export function createBodyParserMiddleware() {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const contentEncoding = req.headers["content-encoding"];

    if (!contentEncoding) {
      return express.json({ limit: "20mb" })(req, res, next);
    }

    const encodings = contentEncoding.split(",").map((e: string) => e.trim().toLowerCase());

    if (!encodings.includes("zstd")) {
      return express.json({ limit: "20mb" })(req, res, next);
    }

    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
      return express.json({ limit: "20mb" })(req, res, next);
    }

    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", async () => {
      try {
        const rawBody = Buffer.concat(chunks);

        let bodyBuffer: Buffer;
        try {
          bodyBuffer = decompress(rawBody, rawBody.length * 10);
        } catch {
          res.status(400).json({
            error: {
              message: "Failed to decompress zstd body",
              type: "invalid_request_error",
            },
          });
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

    req.on("error", () => {
      next();
    });
  };
}