import { NextRequest, NextResponse } from "next/server";
import { canUpload, cookieName, newSession, passwordValid } from "@/lib/core";
export const runtime = "nodejs";
export function GET(request: NextRequest) {
  return NextResponse.json({ authenticated: canUpload(request) }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  try {
    if (typeof body?.password !== "string" || !passwordValid(body.password))
      return NextResponse.json({ error: "Incorrect upload password." }, { status: 401 });
    const result = NextResponse.json({ authenticated: true });
    result.cookies.set(cookieName, newSession(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 7 * 86400, path: "/" });
    return result;
  } catch {
    return NextResponse.json({ error: "Upload access is not configured." }, { status: 503 });
  }
}
export function DELETE() {
  const result = NextResponse.json({ authenticated: false });
  result.cookies.set(cookieName, "", { httpOnly: true, sameSite: "lax", maxAge: 0, path: "/" });
  return result;
}
