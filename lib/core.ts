import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { Firestore } from "@google-cloud/firestore";
import type { NextRequest } from "next/server";

export type Picture = {
  id: string; name: string; plu: string; sector: string; filename: string;
  storagePath: string; mime: string; bytes: number; cleaned: boolean; createdAt: string;
};
let database: Firestore | undefined;
let storage: Storage | undefined;
export function db(): Firestore {
  if (!database) database = new Firestore({ projectId: process.env.GCP_PROJECT_ID || undefined });
  return database;
}
export function bucket() {
  if (!process.env.GCS_BUCKET) throw new Error("GCS_BUCKET not configured");
  if (!storage) storage = new Storage({ projectId: process.env.GCP_PROJECT_ID || undefined });
  return storage.bucket(process.env.GCS_BUCKET);
}
const cookie = "t2e_upload_session";
export const cookieName = cookie;
function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  return s;
}
function hash(s: string) { return createHash("sha256").update(s).digest(); }
export function passwordValid(s: string) {
  const p = process.env.UPLOAD_PASSWORD;
  return !!p && p.length >= 12 && timingSafeEqual(hash(s), hash(p));
}
function signature(expires: string) { return createHmac("sha256", secret()).update(expires).digest("hex"); }
export function newSession() {
  const expires = String(Math.floor(Date.now() / 1000) + 7 * 86400);
  return expires + "." + signature(expires);
}
export function canUpload(request: NextRequest) {
  const token = request.cookies.get(cookie)?.value || "";
  const [expires, sig, extra] = token.split(".");
  if (extra || !/^\d{10}$/.test(expires || "") || !/^[0-9a-f]{64}$/.test(sig || "")) return false;
  if (Number(expires) < Date.now() / 1000) return false;
  try { return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(signature(expires), "hex")); }
  catch { return false; }
}
export function normal(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}
function part(s: string) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
export function nameFor(name: string, plu: string, sector: string, mime: string) {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return [part(name), part(plu), part(sector)].join("_") + "." + ext;
}
export function validate(name: string, plu: string, sector: string) {
  if (name.length < 2 || name.length > 80 || !part(name)) return "Enter a valid name (2–80 characters).";
  if (!/^[a-z0-9-]{1,32}$/i.test(plu)) return "PLU must be 1–32 letters, numbers or hyphens.";
  if (sector.length < 2 || sector.length > 60 || !part(sector)) return "Enter a valid sector (2–60 characters).";
  return null;
}
export function fileMime(bytes: Buffer) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP") return "image/webp";
  return null;
}
export async function enhanceImage(bytes: Buffer, mime: string) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("AI cleanup is not configured. Upload without cleanup or ask the administrator.");
  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini");
  form.append("quality", "low"); form.append("size", "1024x1024");
  form.append("output_format", "webp"); form.append("n", "1");
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mime }), "source." + (mime === "image/jpeg" ? "jpg" : mime.split("/")[1]));
  form.append("prompt", "Clean up this catering product photo for a professional food catalogue. Improve lighting, sharpness, colour balance and background. Preserve the actual food, ingredients, portion, packaging and product identity exactly. Do not add ingredients, garnish, labels, logos or objects.");
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { Authorization: "Bearer " + key },
      body: form, signal: AbortSignal.timeout(110000), cache: "no-store"
    });
  } catch { throw new Error("AI cleanup connection failed. Retry or upload without cleanup."); }
  if (!res.ok) { console.error("OpenAI edit failed", res.status); throw new Error("AI cleanup failed (" + res.status + "). Try without cleanup."); }
  const data = await res.json() as { data?: Array<{ b64_json?: string }> };
  if (!data.data?.[0]?.b64_json) throw new Error("AI cleanup returned no image.");
  const output = Buffer.from(data.data[0].b64_json, "base64");
  if (output.length > 18 * 1024 * 1024 || fileMime(output) !== "image/webp") throw new Error("Invalid AI image returned.");
  return output;
}
export function newId() { return randomUUID(); }
