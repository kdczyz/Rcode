import assert from "node:assert/strict";
import test from "node:test";
import { parseGeneratedImages } from "./imageProvider";

test("parses OpenAI-compatible base64 image responses", () => {
  const images = parseGeneratedImages({
    data: [{ b64_json: Buffer.from("image-bytes").toString("base64"), revised_prompt: "A quiet lake" }]
  }, "jpeg");

  assert.equal(images.length, 1);
  assert.equal(images[0]?.kind, "image");
  assert.equal(images[0]?.mimeType, "image/jpeg");
  assert.equal(images[0]?.dataUrl, `data:image/jpeg;base64,${Buffer.from("image-bytes").toString("base64")}`);
  assert.equal(images[0]?.text, "A quiet lake");
});

test("accepts HTTPS image URLs and rejects unsafe URLs", () => {
  const images = parseGeneratedImages({
    images: [
      { url: "https://cdn.example.com/generated.png", mime_type: "image/png" },
      { url: "http://127.0.0.1/private.png" }
    ]
  }, "png");

  assert.equal(images.length, 1);
  assert.equal(images[0]?.url, "https://cdn.example.com/generated.png");
  assert.equal(images[0]?.mimeType, "image/png");
});

test("limits parsed image batches to four entries", () => {
  const encoded = Buffer.from("x").toString("base64");
  const images = parseGeneratedImages({ data: Array.from({ length: 7 }, () => ({ b64_json: encoded })) });
  assert.equal(images.length, 4);
});
