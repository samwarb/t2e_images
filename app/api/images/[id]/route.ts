import { NextRequest, NextResponse } from "next/server";
import { bucket, db, type Picture } from "@/lib/core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  try {
    const doc = await db().collection("images").doc(id).get();
    if (!doc.exists) return new Response("Not found", { status: 404 });
    const p = doc.data() as Picture;
    if (!p.storagePath.startsWith("images/" + id + "/")) return new Response("Not found", { status: 404 });
    const [bytes] = await bucket().file(p.storagePath).download();
    const name = p.filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return new NextResponse(new Uint8Array(bytes), { headers: {
      "Content-Type": p.mime, "Content-Disposition": 'inline; filename="' + name + '"',
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "X-Content-Type-Options": "nosniff", "Content-Length": String(bytes.length)
    } });
  } catch (error) {
    console.error("Image fetch failed", error);
    return new Response("Image unavailable", { status: 503 });
  }
}
