import type { RedirectRecord, RequestOperationContext } from "@aic/contracts";

import { PRIVATE_TOP_LEVEL_SEGMENTS, PUBLIC_PAGE_FAMILIES } from "./routes.ts";
import { safeRelativeReturnUrl } from "./boundary.ts";

export const RESERVED_DYNAMIC_SLUGS = new Set([
  ...PRIVATE_TOP_LEVEL_SEGMENTS,
  ...PUBLIC_PAGE_FAMILIES.map((path) => path.split("/")[1]).filter((value): value is string => Boolean(value)),
  "api",
  "app",
  "login",
  "wp-content",
]);

export type DynamicPageOwnership = "owned" | "not_owned" | "unavailable";

/** A redirect lookup outage is distinct from an authoritative miss. */
export type RedirectResolution = RedirectRecord | null | "unavailable";

export interface ApplicationRouteDependencies {
  /** Unavailable fails closed so a possibly published page is never shadowed. */
  readonly dynamicPageOwnership: (
    context: RequestOperationContext,
    slug: string,
  ) => Promise<DynamicPageOwnership>;
  readonly resolveRedirect: (
    context: RequestOperationContext,
    pathname: string,
  ) => Promise<RedirectResolution>;
}

export type ApplicationRouteDecision =
  | { readonly kind: "continue_to_application" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "redirect"; readonly status: 301 | 302 | 307 | 308; readonly location: string };

export function dynamicPublicSlug(pathname: string): string | null {
  const slug = pathname.match(/^\/([^/]+)\/?$/)?.[1]?.toLowerCase();
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED_DYNAMIC_SLUGS.has(slug)) {
    return null;
  }
  return slug;
}

function redirectLocation(destination: string, requestUrl: string): string | null {
  const safeDestination = safeRelativeReturnUrl(destination);
  if (!safeDestination) return null;
  const target = new URL(safeDestination, "https://aic-redirect.invalid");
  const source = new URL(requestUrl);
  const destinationKeys = new Set(target.searchParams.keys());
  for (const [key, value] of source.searchParams) {
    if (!destinationKeys.has(key)) target.searchParams.append(key, value);
  }
  return `${target.pathname}${target.search}`;
}

/**
 * Application-layer resolver for a catch-all route or custom OpenNext wrapper.
 * It is intentionally separate from global auth admission so CMS/data lookups
 * do not execute for every request.
 */
export async function resolveApplicationRoute(
  context: RequestOperationContext,
  requestUrl: string,
  dependencies: ApplicationRouteDependencies,
): Promise<ApplicationRouteDecision> {
  const { pathname } = new URL(requestUrl);
  const slug = dynamicPublicSlug(pathname);
  if (slug) {
    const ownership = await dependencies.dynamicPageOwnership(context, slug);
    if (ownership !== "not_owned") return { kind: "continue_to_application" };
  }

  const redirect = await dependencies.resolveRedirect(context, pathname);
  if (redirect === "unavailable") return { kind: "unavailable" };
  if (!redirect) return { kind: "continue_to_application" };
  const location = redirectLocation(redirect.destination, requestUrl);
  return location
    ? { kind: "redirect", status: redirect.status, location }
    : { kind: "continue_to_application" };
}
