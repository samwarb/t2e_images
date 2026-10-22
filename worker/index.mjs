// Cloudflare Worker for the GitHub Pages image library.
// Credentials are Cloudflare secrets. Never expose them in the static site.
const MAX_UPLOAD = 8 * 1024 * 1024;
const PREFIX = "t2e-library/";
const LIBRARY_PUBLIC_ID = /^t2e-library\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9-]+_[a-z0-9-]+_[a-z0-9-]+$/i;
const LIBRARY_ASSET_ID = /^[a-z0-9_-]{8,128}$/i;
const RESPONSE_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const SECTORS = new Set(["B&I", "Chartwells", "Compass One", "Levy", "RA", "Ireland"]);
const STYLE_GUIDE = "Use a consistent, photorealistic catering menu style inspired by a colorful grain bowl photographed close-up from a slightly overhead angle: a simple off-white speckled ceramic bowl or plate when appropriate, a pale warm stone surface, soft diffused natural daylight, warm neutral tones, crisp authentic food texture, subtle shadows, and minimal clutter. Keep the food as the focus. No added text, labels, logos, or decorative props.";

function originHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN || "https://samwarb.github.io";
  if (origin && (origin === allowed || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
    return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Upload-Password", "Vary": "Origin" };
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
function contextString(context) {
  return Object.entries(context)
    .filter(([key, value]) => /^[a-z0-9_-]+$/i.test(key) && value !== undefined && value !== null)
    .map(([key, value]) => key + "=" + cloudinaryContext(String(value)))
    .join("|");
}
function cloudinaryAuth(env) { return "Basic " + btoa(env.CLOUDINARY_API_KEY + ":" + env.CLOUDINARY_API_SECRET); }
function pictureFromAsset(asset) {
  const context = asset.context?.custom || asset.context || {};
  const original = asset.public_id?.split("/").pop() || "image";
  return {
    id: asset.asset_id || asset.public_id,
    publicId: asset.public_id,
    name: typeof context.name === "string" ? context.name : original,
    plu: typeof context.plu === "string" ? context.plu : "",
    sector: typeof context.sector === "string" ? context.sector : "Uncategorised",
    filename: original + "." + (asset.format || "jpg"),
    bytes: asset.bytes || 0,
    cleaned: context.cleaned === "yes",
    generated: context.generated === "yes",
    createdAt: asset.created_at || new Date().toISOString(),
    url: asset.secure_url
  };
}

async function catalogue(request, env) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor && (cursor.length > 1024 || !/^[A-Za-z0-9_\-=]+$/.test(cursor))) return err(request, env, 400, "Invalid page cursor.");
  const bulk = new URL(request.url).searchParams.get("bulk") === "1";
  const params = new URLSearchParams({ prefix: PREFIX, max_results: bulk ? "500" : "48", context: "true" });
  if (cursor) params.set("next_cursor", cursor);
  const endpoint = "https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/resources/image/upload?" + params;
  const response = await fetch(endpoint, { headers: { Authorization: cloudinaryAuth(env), Accept: "application/json" } });
  if (!response.ok) {
    console.error("Cloudinary asset list request failed", response.status);
    return err(request, env, 502, "Unable to load images from Cloudinary.");
  }
  const payload = await response.json();
  const images = (payload.resources || []).filter(asset =>
    typeof asset.secure_url === "string" && asset.secure_url.startsWith("https://res.cloudinary.com/" + env.CLOUDINARY_CLOUD_NAME + "/")
  ).map(pictureFromAsset);
  images.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(request, env, { images, nextCursor: payload.next_cursor || null }, 200, { "Cache-Control": "public, max-age=30" });
}

async function imageFromOpenAI(body, action, env) {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI image generation is not configured. Ask the administrator to add the OpenAI API key.");
  let response;
  const headers = { Authorization: "Bearer " + env.OPENAI_API_KEY };
  if (!(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  try {
    response = await fetch("https://api.openai.com/v1/images/" + (action === "generate" ? "generations" : "edits"), {
      method: "POST", headers, body
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
  const body = {
    model: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
    quality: "low",
    size: "1024x1024",
    n: 1,
    output_format: "webp",
    prompt: "Create one realistic, appetising catering menu-catalogue photograph showing: " + description + ". Follow these visual directions: " + STYLE_GUIDE + " Keep the requested food recognizable and plausible, with no text, labels, logos, or extra props."
  };
  return imageFromOpenAI(body, "generate", env);
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
      publicId, cleaned, generated, createdAt: saved.created_at || new Date().toISOString(), url: saved.secure_url }
  }, 201);
}

async function deleteImage(request, env) {
  const candidate = request.headers.get("X-Upload-Password") || "";
  if (!(await passwordOk(candidate, env.UPLOAD_PASSWORD))) return err(request, env, 401, "Incorrect upload password.");
  let publicId;
  try { publicId = (await request.json())?.publicId; }
  catch { return err(request, env, 400, "Invalid delete request."); }
  if (typeof publicId !== "string" || publicId.length > 256 || !LIBRARY_PUBLIC_ID.test(publicId))
    return err(request, env, 400, "This image cannot be deleted from the library.");

  const timestamp = String(Math.floor(Date.now() / 1000));
  const unsigned = { invalidate: "true", public_id: publicId, timestamp };
  const stringToSign = Object.entries(unsigned).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&");
  const signature = await sha1Hex(stringToSign + env.CLOUDINARY_API_SECRET);
  const form = new FormData();
  form.append("public_id", publicId);
  form.append("timestamp", timestamp);
  form.append("invalidate", "true");
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("signature", signature);
  const endpoint = "https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/image/destroy";
  const response = await fetch(endpoint, { method: "POST", body: form });
  if (!response.ok) {
    console.error("Cloudinary asset delete failed", response.status);
    return err(request, env, 502, "Cloudinary could not delete this image. Please try again.");
  }
  const result = await response.json();
  if (result?.result === "not found") return err(request, env, 404, "This image is no longer in Cloudinary.");
  if (result?.result !== "ok") return err(request, env, 502, "Cloudinary did not confirm the image deletion.");
  return json(request, env, { deleted: true });
}

async function getLibraryAsset(assetId, publicId, request, env) {
  if (typeof assetId !== "string" || !LIBRARY_ASSET_ID.test(assetId) ||
      typeof publicId !== "string" || publicId.length > 256 || !LIBRARY_PUBLIC_ID.test(publicId)) {
    return { error: err(request, env, 400, "This image cannot be changed from the library.") };
  }
  const endpoint = "https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/resources/" + encodeURIComponent(assetId) + "?context=true";
  const response = await fetch(endpoint, { headers: { Authorization: cloudinaryAuth(env), Accept: "application/json" } });
  if (response.status === 404) return { error: err(request, env, 404, "This image is no longer in Cloudinary.") };
  if (!response.ok) {
    console.error("Cloudinary asset lookup failed", response.status);
    return { error: err(request, env, 502, "Cloudinary could not load this image. Please try again.") };
  }
  const asset = await response.json();
  if (asset.asset_id !== assetId || asset.public_id !== publicId || !LIBRARY_PUBLIC_ID.test(asset.public_id || "")) {
    return { error: err(request, env, 404, "This image is not in the library.") };
  }
  if (typeof asset.secure_url !== "string" || !asset.secure_url.startsWith("https://res.cloudinary.com/" + env.CLOUDINARY_CLOUD_NAME + "/")) {
    return { error: err(request, env, 400, "This image cannot be changed from the library.") };
  }
  return { asset };
}

async function updateImageName(request, env, asset, body) {
  const current = asset.context?.custom || asset.context || {};
  const name = tidy(body.name, 81);
  const plu = tidy(current.plu || body.plu, 33);
  const sector = tidy(current.sector || body.sector, 61);
  const failure = validate(name, plu, sector);
  if (failure) return err(request, env, 400, failure);
  const context = { ...current, name, plu, sector };
  if (context.cleaned !== "yes") context.cleaned = "no";
  if (context.generated !== "yes") context.generated = "no";
  const endpoint = "https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/resources/" + encodeURIComponent(asset.asset_id);
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { Authorization: cloudinaryAuth(env), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ context: contextString(context) })
  });
  if (!response.ok) {
    console.error("Cloudinary image metadata update failed", response.status);
    return err(request, env, 502, "Cloudinary could not update the image name. Please try again.");
  }
  return json(request, env, { image: { ...pictureFromAsset(asset), name } });
}

async function copyAssetToSector(source, name, plu, sector, mime, context, env) {
  const filename = filenameFor(name, plu, sector, mime);
  const id = crypto.randomUUID();
  const publicId = PREFIX + id + "/" + filename.slice(0, -(extension(mime).length + 1));
  const copyContext = { ...context, name, plu, sector };
  if (copyContext.cleaned !== "yes") copyContext.cleaned = "no";
  if (copyContext.generated !== "yes") copyContext.generated = "no";
  const serializedContext = contextString(copyContext);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const unsigned = { context: serializedContext, public_id: publicId, timestamp };
  const stringToSign = Object.entries(unsigned).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + "=" + value).join("&");
  const signature = await sha1Hex(stringToSign + env.CLOUDINARY_API_SECRET);
  const form = new FormData();
  form.append("file", source.secure_url);
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("timestamp", timestamp);
  form.append("public_id", publicId);
  form.append("context", serializedContext);
  form.append("signature", signature);
  const endpoint = "https://api.cloudinary.com/v1_1/" + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + "/image/upload";
  const response = await fetch(endpoint, { method: "POST", body: form });
  if (!response.ok) {
    console.error("Cloudinary image copy failed", response.status);
    return null;
  }
  const saved = await response.json();
  if (typeof saved.secure_url !== "string") return null;
  return {
    id: saved.asset_id || id, publicId, name, plu, sector, filename,
    bytes: saved.bytes || source.bytes || 0,
    cleaned: copyContext.cleaned === "yes", generated: copyContext.generated === "yes",
    createdAt: saved.created_at || new Date().toISOString(), url: saved.secure_url
  };
}

async function copyImageToSectors(request, env, source, body) {
  const current = source.context?.custom || source.context || {};
  const name = tidy(current.name || body.name, 81);
  const plu = tidy(current.plu || body.plu, 33);
  const sourceSector = tidy(current.sector || body.sector, 61);
  const sourceFailure = validate(name, plu, sourceSector);
  if (sourceFailure) return err(request, env, 400, sourceFailure);
  if (!Array.isArray(body.sectors) || body.sectors.length < 1 || body.sectors.length > SECTORS.size) {
    return err(request, env, 400, "Choose one or more destination sectors.");
  }
  const destinations = [...new Set(body.sectors.map(value => tidy(value, 61)))];
  if (destinations.length !== body.sectors.length || destinations.some(value => !SECTORS.has(value) || value === sourceSector)) {
    return err(request, env, 400, "Choose valid sectors other than the image's current sector.");
  }
  const format = String(source.format || "").toLowerCase();
  const mime = format === "jpg" || format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : format === "webp" ? "image/webp" : "";
  if (!mime) return err(request, env, 400, "This image format cannot be copied to another sector.");
  const images = [];
  const failedSectors = [];
  for (const destination of destinations) {
    try {
      const image = await copyAssetToSector(source, name, plu, destination, mime, current, env);
      if (image) images.push(image);
      else failedSectors.push(destination);
    } catch (error) {
      console.error("Cloudinary image copy request failed", error);
      failedSectors.push(destination);
    }
  }
  if (images.length === 0) return json(request, env, { images, failedSectors, error: "Cloudinary could not create the requested copies. Please try again." }, 502);
  if (failedSectors.length > 0) return json(request, env, { images, failedSectors, error: "Some sectors could not be copied. You can retry the remaining sectors." }, 207);
  return json(request, env, { images, failedSectors }, 201);
}

async function manageImage(request, env) {
  const candidate = request.headers.get("X-Upload-Password") || "";
  if (!(await passwordOk(candidate, env.UPLOAD_PASSWORD))) return err(request, env, 401, "Incorrect upload password.");
  let body;
  try { body = await request.json(); }
  catch { return err(request, env, 400, "Invalid image management request."); }
  if (!body || typeof body !== "object" || (body.action !== "rename" && body.action !== "copy")) {
    return err(request, env, 400, "Choose rename or copy.");
  }
  const { error, asset } = await getLibraryAsset(body.assetId, body.publicId, request, env);
  if (error) return error;
  if (body.action === "rename") return await updateImageName(request, env, asset, body);
  return await copyImageToSectors(request, env, asset, body);
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
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") return err(request, env, 405, "Method not allowed.");
    if (!required(env)) return err(request, env, 503, "Backend not configured. Contact the app administrator.");
    try {
      if (url.pathname === "/api/auth" && request.method === "POST") {
        let password;
        try { password = (await request.json())?.password; } catch { return err(request, env, 400, "Invalid sign-in request."); }
        return (await passwordOk(password, env.UPLOAD_PASSWORD)) ? json(request, env, { authenticated: true }) : err(request, env, 401, "Incorrect upload password.");
      }
      if (url.pathname === "/api/images" && request.method === "GET") return await catalogue(request, env);
      if (url.pathname === "/api/images" && request.method === "POST") return await addImage(request, env);
      if (url.pathname === "/api/images" && request.method === "DELETE") return await deleteImage(request, env);
      if (url.pathname === "/api/images/manage" && request.method === "POST") return await manageImage(request, env);
      return err(request, env, 404, "Not found.");
    } catch (error) {
      console.error("Unhandled image library error", error);
      return err(request, env, 500, "Unexpected server error. Please try again.");
    }
  }
};
export { filenameFor, imageMime, validate, passwordOk };
