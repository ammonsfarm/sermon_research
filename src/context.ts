import type { Session } from "./auth.ts";
import type { AppEnv } from "./env.ts";
import { notFoundView } from "./views.ts";
import { type Html, page } from "./html.ts";
import { adminMenu, siteHeader } from "./layout.ts";
import type { Ministry } from "./settings.ts";
import { DEFAULT_SCHEME, isScheme, type Mode, type SchemeId } from "./theme.ts";

export interface Context {
  readonly request: Request;
  readonly env: AppEnv;
  readonly db: D1Database;
  readonly url: URL;
  readonly session: Session | null;
  readonly ministry: Ministry | null;
  /** True when research is open to visitors who aren't signed in. */
  readonly researchOpen: boolean;
  /** This visitor's light / dark choice, from a cookie. */
  readonly mode: Mode;
}

/** The page chrome for this request: site title, main navigation and, on admin pages, the admin menu. */
export function chrome(context: Context): { siteTitle?: string; logoUrl?: string; scheme?: SchemeId; mode?: Mode; header?: Html; aside?: Html } {
  if (!context.ministry) return { mode: context.mode };
  const path = context.url.pathname;
  const isAdmin = context.session?.user.role === "admin";
  return {
    siteTitle: context.ministry.siteTitle,
    scheme: isScheme(context.ministry.colorScheme) ? context.ministry.colorScheme : DEFAULT_SCHEME,
    mode: context.mode,
    ...(context.ministry.logoUrl ? { logoUrl: context.ministry.logoUrl } : {}),
    header: siteHeader(context.session, path, context.researchOpen, context.mode, path + context.url.search),
    ...(isAdmin && path.startsWith("/admin") ? { aside: adminMenu(path) } : {}),
  };
}

export function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function requireAdmin(context: Context): Response | null {
  if (!context.session) return redirect("/login");
  if (context.session.user.role !== "admin") return page("Not allowed", notFoundView(), { status: 403, ...chrome(context) });
  return null;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
