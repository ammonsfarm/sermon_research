import type { Session } from "./auth.ts";
import type { AppEnv } from "./env.ts";
import { notFoundView } from "./views.ts";
import { page } from "./html.ts";
import type { Ministry } from "./settings.ts";

export interface Context {
  readonly request: Request;
  readonly env: AppEnv;
  readonly db: D1Database;
  readonly url: URL;
  readonly session: Session | null;
  readonly ministry: Ministry | null;
}

export function siteTitle(context: Context): { siteTitle?: string } {
  return context.ministry ? { siteTitle: context.ministry.siteTitle } : {};
}

export function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function requireAdmin(context: Context): Response | null {
  if (!context.session) return redirect("/login");
  if (context.session.user.role !== "admin") return page("Not allowed", notFoundView(), { status: 403, ...siteTitle(context) });
  return null;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
