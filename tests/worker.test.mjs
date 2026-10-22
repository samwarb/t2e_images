import assert from "node:assert/strict";
import { test } from "node:test";
import { filenameFor, imageMime, passwordOk, validate } from "../worker/index.mjs";

test("filename is name_PLU_sector", () => {
  assert.equal(filenameFor("Vegan Chilli", "00123", "Business & Industry", "image/jpeg"), "vegan-chilli_00123_business-industry.jpg");
  assert.equal(filenameFor("Crème Brûlée", "00123", "Education", "image/webp"), "creme-brulee_00123_education.webp");
});
test("validation preserves leading zero PLUs", () => {
  assert.equal(validate("Vegan Chilli", "00123", "Education"), null);
  assert.match(validate("Vegan Chilli", "../bad", "Education"), /PLU/);
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
