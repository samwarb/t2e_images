import { NextRequest, NextResponse } from "next/server";
import { bucket, canUpload, db, enhanceImage, fileMime, nameFor, newId, normal, validate, type Picture } from "@/lib/core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const LIMIT = 48;
export async function GET(request: NextRequest) {
  try {
    let query = db().collection("images").orderBy("createdAt", "desc").limit(LIMIT);
    const cursor = request.nextUrl.searchParams.get("cursor");
    if (cursor) {
      if (!/^[0-9a-f-]{36}$/.test(cursor)) return NextResponse.json({ error: "Invalid page." }, { status: 400 });
      const last = await db().collection("images").doc(cursor).get();
      if (!last.exists) return NextResponse.json({ error: "Page expired." }, { status: 400 });
      query = query.startAfter(last);
    }
    const snap = await query.get();
    const images = snap.docs.map(doc => {
      const p = doc.data() as Picture;
      return { id: doc.id, name: p.name, plu: p.plu, sector: p.sector,
        filename: p.filename, bytes: p.bytes, cleaned: p.cleaned, createdAt: p.createdAt,
        url: "/api/images/" + doc.id };
    });
    return NextResponse.json({ images, nextCursor: snap.size === LIMIT ? snap.docs[snap.docs.length-1].id : null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Image library list failed", error);
    return NextResponse.json({ error: "Could not load the library. Check GCP configuration." }, { status: 500 });
  }
}
export async function POST(request: NextRequest) {
  if (!canUpload(request)) return NextResponse.json({ error: "Sign in before uploading." }, { status: 401 });
  try {
    const form = await request.formData();
    const name = normal(form.get("name"), 80);
    const plu = normal(form.get("plu"), 32);
    const sector = normal(form.get("sector"), 60);
    const error = validate(name, plu, sector);
    if (error) return NextResponse.json({ error }, { status: 400 });
    const source = form.get("image");
    if (!(source instanceof File) || source.size < 1 || source.size > 8 * 1024 * 1024)
      return NextResponse.json({ error: "Choose a JPEG, PNG or WebP image under 8 MB." }, { status: 400 });
    const original = Buffer.from(await source.arrayBuffer());
    const mime = fileMime(original);
    if (!mime || source.type !== mime)
      return NextResponse.json({ error: "Only valid JPEG, PNG or WebP images are supported." }, { status: 400 });
    const cleaned = form.get("cleanup") === "true";
    let output = original;
    if (cleaned) {
      try { output = await enhanceImage(original, mime); }
      catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "AI cleanup failed." }, { status: 502 }); }
    }
    const resultMime = cleaned ? "image/webp" : mime;
    const id = newId();
    const filename = nameFor(name, plu, sector, resultMime);
    const storagePath = "images/" + id + "/" + filename;
    const record: Picture = { id, name, plu, sector, filename, storagePath,
      mime: resultMime, bytes: output.length, cleaned, createdAt: new Date().toISOString() };
    const object = bucket().file(storagePath);
    await object.save(output, { resumable: false, metadata: { contentType: resultMime } });
    try { await db().collection("images").doc(id).create(record); }
    catch (e) { await object.delete().catch(() => undefined); throw e; }
    return NextResponse.json({ image: { id, name, plu, sector, filename, bytes: output.length,
      cleaned, createdAt: record.createdAt, url: "/api/images/" + id } }, { status: 201 });
  } catch (error) {
    console.error("Image upload error", error);
    return NextResponse.json({ error: "Upload failed. Check the server configuration and retry." }, { status: 500 });
  }
}
