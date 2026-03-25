import { decompress } from "zstd-napi";
import express from "express";

function parseJsonBody(raw: Buffer): Record<string, unknown> {
  const str = raw.toString("utf-8");
  try {
    return JSON.parse(str);
  } catch {
    throw new Error("Invalid JSON");
  }
}

function standardJsonParser(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "DELETE" ||
    req.method === "OPTIONS" ||
    req.method === "TRACE" ||
    req.method === "CONNECT"
  ) {
    return next();
  }

  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("application/json")) {
    return next();
  }

  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    try {
      const rawBody = Buffer.concat(chunks);
      req.body = parseJsonBody(rawBody);
      next();
    } catch {
      res.status(400).json({
        error: {
          message: "Invalid JSON",
          type: "invalid_request_error",
        },
      });
    }
  });

  req.on("error", () => {
    next();
  });
}

function zstdDecompressionHandler(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    try {
      const rawBody = Buffer.concat(chunks);

      let bodyBuffer: Buffer;
      try {
        bodyBuffer = decompress(rawBody);
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
        req.body = parseJsonBody(bodyBuffer);
      } catch {
        res.status(400).json({
          error: {
            message: "Invalid JSON in decompressed body",
            type: "invalid_request_error",
          },
        });
        return;
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
}

export function createBodyParserMiddleware() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const contentEncoding = req.headers["content-encoding"];

    if (!contentEncoding) {
      return standardJsonParser(req, res, next);
    }

    const encodings = contentEncoding.split(",").map((e: string) => e.trim().toLowerCase());

    if (!encodings.includes("zstd")) {
      return standardJsonParser(req, res, next);
    }

    zstdDecompressionHandler(req, res, next);
  };
}