import {
  type PublicProofType,
  type RequestOperationContext,
  type RouteAccessClass,
  type RouteAccessPolicy,
  type RouteAccessRequest,
} from "@aic/contracts";

export const PRIVATE_TOP_LEVEL_SEGMENTS = [
  "admin",
  "archive",
  "compose",
  "console",
  "content",
  "episodes",
  "overview",
  "pipeline",
  "podcast",
  "reading-plan",
  "research",
  "sermons",
  "preview",
  "signals",
  "sources",
  "stats",
] as const;

export const PUBLIC_PAGE_FAMILIES = [
  "/about-pastor-wood",
  "/abiding-in-christ",
  "/radio",
  "/bible-study",
  "/written-resources",
  "/writings",
  "/contact",
  "/donate",
  "/donor-dashboard",
  "/endorsements",
  "/board-members",
  "/privacy",
  "/privacy-terms-conditions",
  "/unsubscribe",
  "/feed",
  "/media",
  "/wp-content/uploads",
] as const;

export const PUBLIC_API_PROOFS = {
  "/api/revalidate/strapi": "shared_revalidation_secret",
  "/api/public/contact": "same_site_and_body_validation",
  "/api/webhooks/mailchimp": "webhook_hmac",
} as const satisfies Readonly<Record<string, PublicProofType>>;

const STATIC_FILE_PATTERN = /\.(?:html?|css|js|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$/i;

function isFamily(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

function topLevelSegment(pathname: string): string {
  return pathname.match(/^\/([^/]+)(?:\/|$)/)?.[1]?.toLowerCase() ?? "";
}

export function publicProofForPath(pathname: string): PublicProofType | null {
  const exact = PUBLIC_API_PROOFS[pathname as keyof typeof PUBLIC_API_PROOFS];
  if (exact) return exact;
  if (pathname === "/api/public/subscriptions") return "same_site_and_body_validation";
  return isFamily(pathname, "/api/public/subscriptions") ? "signed_unsubscribe_token" : null;
}

export function classifyRoute(request: RouteAccessRequest): RouteAccessClass {
  const pathname = request.pathname;
  if (
    pathname.startsWith("/api/")
    || pathname === "/api"
    || pathname.startsWith("/trpc/")
    || pathname === "/trpc"
  ) {
    return publicProofForPath(pathname) ? "proof_authenticated_public_api" : "private_api";
  }

  // A private namespace stays private even when the final segment resembles a
  // static asset. Otherwise /admin/export.csv or /preview/draft.png bypasses
  // the session boundary.
  const segment = topLevelSegment(pathname);
  if (PRIVATE_TOP_LEVEL_SEGMENTS.includes(segment as (typeof PRIVATE_TOP_LEVEL_SEGMENTS)[number])) {
    return "private_page";
  }

  if (
    pathname === "/"
    || isFamily(pathname, "/login")
    || pathname.startsWith("/_next/")
    || pathname.startsWith("/__clerk/")
    || STATIC_FILE_PATTERN.test(pathname)
    || PUBLIC_PAGE_FAMILIES.some((base) => isFamily(pathname, base))
  ) {
    return "public";
  }

  return "application_resolution";
}

export class PortableRouteAccessPolicy implements RouteAccessPolicy {
  async classify(
    _context: RequestOperationContext,
    request: RouteAccessRequest,
  ): Promise<RouteAccessClass> {
    return classifyRoute(request);
  }
}
