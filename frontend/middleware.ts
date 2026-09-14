import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC = ["/login", "/_next", "/favicon", "/logo", "/icon", "/api"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // allow public assets and login
  if (PUBLIC.some((p) => pathname.startsWith(p))) {
    // if already logged in and hitting /login, send to dashboard
    if (pathname === "/login") {
      const token = req.cookies.get("prova.token")?.value || req.cookies.get("lifeos.token")?.value;
      if (token) {
        const url = req.nextUrl.clone();
        url.pathname = "/";
        return NextResponse.redirect(url);
      }
    }
    return NextResponse.next();
  }

  // protect everything else (/, /chat, /settings, /notifications, /pricing, /dashboard)
  const token = req.cookies.get("prova.token")?.value || req.cookies.get("lifeos.token")?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
