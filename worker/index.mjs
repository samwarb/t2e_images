// Cloudflare Worker for the GitHub Pages image library.
// Credentials are Cloudflare secrets. Never expose them in the static site.
const MAX_UPLOAD = 8 * 1024 * 1024;
const PREFIX = "t2e-library/";
const RESPONSE_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const SECTORS = new Set(["B&I", "Chartwells", "Compass One", "Levy", "RA", "Ireland"]);
const STYLE_GUIDE = "Use a consistent, photorealistic catering menu style inspired by a colorful grain bowl photographed close-up from a slightly overhead angle: a simple off-white speckled ceramic bowl or plate when appropriate, a pale warm stone surface, soft diffused natural daylight, warm neutral tones, crisp authentic food texture, subtle shadows, and minimal clutter. Keep the food as the focus. No added text, labels, logos, or decorative props.";

function originHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || "https://samwarb.github.io";
  if (origin && (origin === allowed || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
    return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Upload-Password", "Vary": "Origin" };
  }
  return { "Vary": "Origin" };
}

function json(request, env, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...RESPONSE_HEADERS, ...originHeaders(request, env), ...extra } });
}
function err(request, env, status, message) { return json(request, env, { error: message }, status); }
function required(env) {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET && env.UPLOAD_PASSWORD);
}
function tidy(value, max = 80) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}
function slug(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function validate(name, plu, sector) {
  if (name.length < 2 || name.length > 80 || !slug(name)) return "Enter a valid image name (2–80 characters).";
  if (!/^[a-z0-9-]{1,32}$/i.test(plu)) return "PLU must be 1–32 letters, numbers or hyphens.";
  if (!SECTORS.has(sector)) return "Choose one of the available sectors.";
  return null;
}
function imageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 8 && bytes.slice(0,8).every((b,i) => b === [137,80,78,71,13,10,26,10][i])) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP") return "image/webp";
  return null;
}
function extension(mime) { return mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp"; }
function filenameFor(name, plu, sector, mime) { return [slug(name), slug(plu), slug(sector)].join("_") + "." + extension(mime); }
async function passwordOk(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string" || expected.length < 12) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(expected))
  ]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i=0; i<aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}
async function sha1Hex(value) {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value)));
  return [...result].map(v => v.toString(16).padStart(2, "0")).join("");
}
function cloudinaryContext(value) { return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/=/g, "\\="); }

async function catalogue(request, env) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor && (cursor.length > 1024 || !/^[A-Za-z0-9_\-=]+$/.test(cursor))) return err(request, env, 400, "Invalid page cursor.");
  const params = new URLSearchParams({ prefix: PREFIX, max_results: "48", context: "true" });
  if (cursor) params.set("next_cursor", cursor);
  const auth = btoa(env.CLOUDINARY_API_KEY + ":" + env.CLOUDINARY_API_SECRET);
  const endpoint = "https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/resources/image/upload?" + params;
  const response = await fetch(endpoint, { headers: { Authorization: "Basic " + auth, Accept: "application/json" } });
  if (!response.ok) {
    console.error("Cloudinary asset list request failed", response.status);
    return err(request, env, 502, "Unable to load images from Cloudinary.");
  }
  const payload = await response.json();
  const images = (payload.resources || []).filter(asset =>
    typeof asset.secure_url === "string" && asset.secure_url.startsWith("https://res.cloudinary.com/" + env.CLOUDINARY_CLOUD_NAME + "/")
  ).map(asset => {
    const c = asset.context?.custom || asset.context || {};
    const original = asset.public_id?.split("/").pop() || "image";
    const name = typeof c.name === "string" ? c.name : original;
    const plu = typeof c.plu === "string" ? c.plu : "";
    const sector = typeof c.sector === "string" ? c.sector : "Uncategorised";
    return {
      id: asset.asset_id || asset.public_id,
      name, plu, sector, filename: original + "." + (asset.format || "jpg"),
      bytes: asset.bytes || 0,
      cleaned: c.cleaned === "yes",
      generated: c.generated === "yes",
      createdAt: asset.created_at || new Date().toISOString(),
      url: asset.secure_url
    };
  });
  images.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(request, env, { images, nextCursor: payload.next_cursor || null }, 200, { "Cache-Control": "public, max-age=30" });
}

async function imageFromOpenAI(form, action, env) {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI image generation is not configured. Ask the administrator to add the OpenAI API key.");
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/images/" + (action === "generate" ? "generations" : "edits"), {
      method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, body: form
    });
  } catch { throw new Error("Unable to reach OpenAI. Please try again."); }
  if (!response.ok) {
    console.error("OpenAI image " + action + " error", response.status);
    throw new Error("OpenAI image " + (action === "generate" ? "generation" : "cleanup") + " failed (" + response.status + "). No image has been uploaded.");
  }
  const result = await response.json();
  const base64 = result?.data?.[0]?.b64_json;
  if (typeof base64 !== "string" || base64.length > 16 * 1024 * 1024) throw new Error("OpenAI returned no valid image.");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (imageMime(bytes) !== "image/webp") throw new Error("OpenAI returned an unexpected image format.");
  return new Blob([bytes], { type: "image/webp" });
}
async function enhance(source, mime, env) {
  const form = new FormData();
  form.append("model", env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst");
  form.append("quality", "low");
  form.append("size", "1024x1024");
  form.append("n", "1");
  form.append("output_format", "webp");
  form.append("image", source, "original." + extension(mime));
  form.append("prompt", "Retouch this existing food or catering product photograph into a polished professional menu-catalogue image. Preserve the exact food, ingredients, portion size, packaging, labels, branding, and key subject. Apply this consistent photographic style: " + STYLE_GUIDE + " Improve lighting, clarity, neutral colour balance, framing, and background cleanliness. Keep the original serving vessel when one is present. Remove only unwanted visual clutter; do not invent or remove food, ingredients, text, brand marks, or packaging details.");
  return imageFromOpenAI(form, "cleanup", env);
}
async function generate(description, env) {
  const form = new FormData();
  form.append("model", env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst");
  form.append("quality", "low");
  form.append("size", "1024x1024");
  form.append("n", "1");
  form.append("output_format", "webp");
  form.append("prompt", "Create one realistic, appetising catering menu-catalogue photograph showing: " + description + ". Follow these visual directions: " + STYLE_GUIDE + " Keep the requested food recognizable and plausible, with no text, labels, logos, or extra props.");
  return imageFromOpenAI(form, "generate", env);
}
async function addImage(request, env) {
  const candidate = request.headers.get("X-Upload-Password") || "";
  if (!(await passwordOk(candidate, env.UPLOAD_PASSWORD))) return err(request, env, 401, "Incorrect upload password.");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 10 * 1024 * 1024) return err(request, env, 413, "The image must be under 8 MB.");
  let form;
  try { form = await request.formData(); }
  catch { return err(request, env, 400, "Invalid upload data."); }

  const name = tidy(form.get("name"), 81);
  const plu = tidy(form.get("plu"), 33);
  const sector = tidy(form.get("sector"), 61);
  const mode = tidy(form.get("mode"), 16) || "upload";
  const description = tidy(form.get("description"), 1001);
  const failure = validate(name, plu, sector);
  if (failure) return err(request, env, 400, failure);
  if (mode !== "upload" && mode !== "generate") return err(request, env, 400, "Choose upload or AI generation.");

  const generated = mode === "generate";
  const cleaned = !generated && form.get("cleanup") === "true";
  let blob;
  let resultMime;
  if (generated) {
    if (description.length < 3 || description.length > 1000) return err(request, env, 400, "Describe the image in 3–1000 characters.");
    try { blob = await generate(description, env); resultMime = "image/webp"; }
    catch (error) { return err(request, env, 502, error instanceof Error ? error.message : "AI image generation failed."); }
  } else {
    const source = form.get("image");
    if (!(source instanceof File) || source.size < 1 || source.size > MAX_UPLOAD)
      return err(request, env, 400, "Select a valid JPG, PNG or WebP image smaller than 8 MB.");
    const signature = new Uint8Array(await source.slice(0, 16).arrayBuffer());
    const mime = imageMime(signature);
    if (!mime || source.type !== mime) return err(request, env, 400, "Unsupported image format.");
    blob = source;
    resultMime = mime;
    if (cleaned) {
      try { blob = await enhance(source, mime, env); resultMime = "image/webp"; }
      catch (error) { return err(request, env, 502, error instanceof Error ? error.message : "AI cleanup failed."); }
    }
  }

  const filename = filenameFor(name, plu, sector, resultMime);
  const id = crypto.randomUUID();
  const publicId = PREFIX + id + "/" + filename.slice(0, -(extension(resultMime).length + 1));
  const context = "name=" + cloudinaryContext(name) + "|plu=" + cloudinaryContext(plu) + "|sector=" + cloudinaryContext(sector) + "|cleaned=" + (cleaned ? "yes" : "no") + "|generated=" + (generated ? "yes" : "no");
  const timestamp = String(Math.floor(Date.now()/1000));
  const unsigned = { context, public_id: publicId, timestamp };
  const stringToSign = Object.entries(unsigned).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k + "=" + v).join("&");
  const signatureHex = await sha1Hex(stringToSign + env.CLOUDINARY_API_SECRET);
  const cloudForm = new FormData();
  cloudForm.append("file", blob, filename);
  cloudForm.append("api_key", env.CLOUDINARY_API_KEY);
  cloudForm.append("timestamp", timestamp);
  cloudForm.append("public_id", publicId);
  cloudForm.append("context", context);
  cloudForm.append("signature", signatureHex);

  const response = await fetch("https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/image/upload", { method: "POST", body: cloudForm });
  if (!response.ok) {
    console.error("Cloudinary upload failed", response.status);
    return err(request, env, 502, "Image storage upload failed; please try again.");
  }
  const saved = await response.json();
  if (typeof saved.secure_url !== "string") return err(request, env, 502, "Storage provider did not return an image URL.");
  return json(request, env, {
    image: { id: saved.asset_id || id, name, plu, sector, filename, bytes: saved.bytes || blob.size,
      cleaned, generated, createdAt: saved.created_at || new Date().toISOString(), url: saved.secure_url }
  }, 201);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      const allowed = env.ALLOWED_ORIGIN || "https://samwarb.github.io";
      if (!origin || (origin !== allowed && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { ...originHeaders(request, env), "Access-Control-Max-Age": "86400" } });
    }
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json(request, env, { ok: true, configured: required(env) });
    if (request.method !== "GET" && request.method !== "POST") return err(request, env, 405, "Method not allowed.");
    if (!required(env)) return err(request, env, 503, "Backend not configured. Contact the app administrator.");
    try {
      if (url.pathname === "/api/auth" && request.method === "POST") {
        let password;
        try { password = (await request.json())?.password; } catch { return err(request, env, 400, "Invalid sign-in request."); }
        return (await passwordOk(password, env.UPLOAD_PASSWORD)) ? json(request, env, { authenticated: true }) : err(request, env, 401, "Incorrect upload password.");
      }
      if (url.pathname === "/api/images" && request.method === "GET") return await catalogue(request, env);
      if (url.pathname === "/api/images" && request.method === "POST") return await addImage(request, env);
      return err(request, env, 404, "Not found.");
    } catch (error) {
      console.error("Unhandled image library error", error);
      return err(request, env, 500, "Unexpected server error. Please try again.");
    }
  }
};
export { filenameFor, imageMime, validate, passwordOk };
