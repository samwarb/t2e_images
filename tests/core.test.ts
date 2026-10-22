import assert from "node:assert/strict";
import { test } from "node:test";
import { fileMime, nameFor, normal, validate } from "../lib/core";
test("name_PLU_sector filename", () => {
  assert.equal(nameFor("Vegan Chilli", "00123", "Business & Industry", "image/jpeg"), "vegan-chilli_00123_business-industry.jpg");
});
test("reject invalid PLUs", () => {
  assert.equal(validate("Vegan Chilli", "0008", "Education"), null);
  assert.match(validate("Vegan Chilli", "../../x", "Education") || "", /PLU/);
});
test("normalise whitespace", () => assert.equal(normal("  Vegan   Chilli  ",80), "Vegan Chilli"));
test("reject unsupported image formats", () => assert.equal(fileMime(Buffer.from("GIF89a")), null));
