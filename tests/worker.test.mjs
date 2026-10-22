import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { filenameFor, imageMime, passwordOk, validate } from "../worker/index.mjs";

test("filename is name_PLU_sector", () => {
  assert.equal(filenameFor("Vegan Chilli", "00123", "B&I", "image/jpeg"), "vegan-chilli_00123_b-i.jpg");
  assert.equal(filenameFor("Crème Brûlée", "00123", "Chartwells", "image/webp"), "creme-brulee_00123_chartwells.webp");
});
test("validation preserves leading zero PLUs", () => {
  assert.equal(validate("Vegan Chilli", "00123", "Compass One"), null);
  assert.match(validate("Vegan Chilli", "../bad", "Compass One"), /PLU/);
  assert.match(validate("Vegan Chilli", "00123", "QA Test"), /sector/i);
});
test("image signatures exclude GIF and detect PNG", () => {
  assert.equal(imageMime(new Uint8Array([137,80,78,71,13,10,26,10])), "image/png");
  assert.equal(imageMime(new TextEncoder().encode("GIF89a")), null);
});
test("password rejects wrong and short configured passwords", async () => {
  assert.equal(await passwordOk("not-the-password", "the-secret-upload-password"), false);
  assert.equal(await passwordOk("same", "same"), false);
  assert.equal(await passwordOk("the-secret-upload-password", "the-secret-upload-password"), true);
});

const mockEnv = {
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-api-secret",
  UPLOAD_PASSWORD: "test-upload-password-long",
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_IMAGE_MODEL: "gpt-image-2.5-sunburst",
  ALLOWED_ORIGIN: "https://samwarb.github.io"
};
const outputWebp = new Uint8Array([82,73,70,70,4,0,0,0,87,69,66,80]);

async function runImagePost({ mode, cleanup = false }) {
  const previousFetch = globalThis.fetch;
  let openAiEndpoint = "";
  let prompt = "";
  let cloudinaryContext = "";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.openai.com/")) {
      openAiEndpoint = url;
      const openAiForm = init.body;
      prompt = openAiForm.get("prompt");
      assert.equal(openAiForm.get("model"), "gpt-image-2.5-sunburst");
      assert.equal(openAiForm.get("quality"), "low");
      assert.equal(openAiForm.get("size"), "1024x1024");
      assert.equal(openAiForm.get("output_format"), "webp");
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(outputWebp).toString("base64") }] }), { status: 200 });
    }
    if (url.startsWith("https://api.cloudinary.com/")) {
      cloudinaryContext = init.body.get("context");
      return new Response(JSON.stringify({
        asset_id: "test-asset-id",
        secure_url: "https://res.cloudinary.com/test-cloud/image/upload/v1/t2e-library/test.webp",
        bytes: outputWebp.length,
        created_at: "2026-10-22T00:00:00Z"
      }), { status: 200 });
    }
    throw new Error("Unexpected outbound request");
  };
  try {
    const form = new FormData();
    form.append("mode", mode);
    form.append("name", "Roasted Veg Bowl");
    form.append("plu", "001234");
    form.append("sector", "B&I");
    if (mode === "generate") form.append("description", "Roasted vegetables with quinoa and feta");
    else {
      form.append("cleanup", String(cleanup));
      form.append("image", new Blob([new Uint8Array([137,80,78,71,13,10,26,10])], { type: "image/png" }), "source.png");
    }
    const request = new Request("https://worker.example/api/images", {
      method: "POST", headers: { "X-Upload-Password": mockEnv.UPLOAD_PASSWORD }, body: form
    });
    const response = await worker.fetch(request, mockEnv);
    return { response, data: await response.json(), openAiEndpoint, prompt, cloudinaryContext };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("AI generation uses the shared visual style and stores generated metadata", async () => {
  const result = await runImagePost({ mode: "generate" });
  assert.equal(result.response.status, 201);
  assert.equal(result.openAiEndpoint, "https://api.openai.com/v1/images/generations");
  assert.match(result.prompt, /Roasted vegetables with quinoa and feta/);
  assert.match(result.prompt, /off-white speckled ceramic bowl/);
  assert.match(result.cloudinaryContext, /sector=B&I\|cleaned=no\|generated=yes/);
  assert.equal(result.data.image.generated, true);
  assert.equal(result.data.image.cleaned, false);
  assert.equal(result.data.image.filename, "roasted-veg-bowl_001234_b-i.webp");
});

test("AI cleanup uses the same visual style and keeps cleanup metadata distinct", async () => {
  const result = await runImagePost({ mode: "upload", cleanup: true });
  assert.equal(result.response.status, 201);
  assert.equal(result.openAiEndpoint, "https://api.openai.com/v1/images/edits");
  assert.match(result.prompt, /Preserve the exact food/);
  assert.match(result.prompt, /off-white speckled ceramic bowl/);
  assert.match(result.cloudinaryContext, /sector=B&I\|cleaned=yes\|generated=no/);
  assert.equal(result.data.image.cleaned, true);
  assert.equal(result.data.image.generated, false);
});
