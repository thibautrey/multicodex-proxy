import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectPayloadContext,
  payloadHasImage,
} from "./index.js";

test("inspects images and compaction items in one payload traversal", () => {
  const payload = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "before" }],
      },
      { type: "compaction", encrypted_content: "opaque-one" },
      {
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }],
      },
      { type: "compaction", encrypted_content: "opaque-two" },
    ],
  };

  assert.deepEqual(inspectPayloadContext(payload), {
    hasImage: true,
    compactionItemCount: 2,
    latestCompactionIndex: 3,
  });
  assert.equal(payloadHasImage(payload), true);
});

test("supports Chat Completions images without inventing compaction data", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example/image" } },
        ],
      },
    ],
  };

  assert.deepEqual(inspectPayloadContext(payload), {
    hasImage: true,
    compactionItemCount: 0,
    latestCompactionIndex: -1,
  });
});

test("reports an empty text-only context without allocations per item", () => {
  const payload = {
    input: Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: [
        {
          type: index % 2 ? "output_text" : "input_text",
          text: `text-${index}`,
        },
      ],
    })),
  };

  assert.deepEqual(inspectPayloadContext(payload), {
    hasImage: false,
    compactionItemCount: 0,
    latestCompactionIndex: -1,
  });
});
