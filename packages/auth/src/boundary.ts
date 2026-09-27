import {
  type ErrorEnvelope,
  type PublicProofType,
  ServiceError,
  httpStatusForError,
  toErrorEnvelope,
  type RequestOperationContext,
  type RouteAccessClass,
  type RouteAccessPolicy,
  type SessionPrincipal,
  type SessionReader,
} from "@aic/contracts";

import { PortableRouteAccessPolicy, publicProofForPath } from "./routes.ts";

export type RequestBoundaryDecision =
  | {
      readonly kind: "continue";
      readonly access: RouteAccessClass;
      readonly principal: SessionPrincipal | null;
      readonly requiredProof?: PublicProofType;
    }
  | {
      readonly kind: "redirect";
      readonly status: 307;
      readonly location: string;
    }
  | {
      readonly kind: "reject";
      readonly status: number;
      readonly body: ErrorEnvelope;
    };

const UNSAFE_RETURN_URL = /[\\\u0000-\u001F\u007F]/;

export function safeRelativeReturnUrl(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || UNSAFE_RETURN_URL.test(value)) {
    return null;
  }
  try {
    let decoded = value;
    for (let depth = 0; depth < 3; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        if (depth === 0) return null;
        break;
      }
      if (next.startsWith("//") || UNSAFE_RETURN_URL.test(next)) return null;
      if (next === decoded) break;
      decoded = next;
    }
    const parsed = new URL(value, "https://aic-return.invalid");
    if (parsed.origin !== "https://aic-return.invalid") return null;
    parsed.searchParams.delete("_rsc");
    const query = parsed.searchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

export function requestReturnUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl);
  parsed.searchParams.delete("_rsc");
  const query = parsed.searchParams.toString();
  return safeRelativeReturnUrl(`${parsed.pathname}${query ? `?${query}` : ""}`) ?? "/content";
}

export function loginRedirectLocation(requestUrl: string): string {
  const search = new URLSearchParams({ redirect_url: requestReturnUrl(requestUrl) });
  return `/login?${search.toString()}`;
}

export interface RequestBoundaryInput {
  readonly request: Pick<Request, "url" | "method" | "headers">;
  readonly context: RequestOperationContext;
  readonly sessions: SessionReader;
  readonly routes?: RouteAccessPolicy;
}

export async function decideRequestBoundary(
  input: RequestBoundaryInput,
): Promise<RequestBoundaryDecision> {
  const parsed = new URL(input.request.url);
  const routes = input.routes ?? new PortableRouteAccessPolicy();
  const access = await routes.classify(input.context, {
    method: input.request.method,
    pathname: parsed.pathname,
  });

  if (access === "public" || access === "application_resolution") {
    return { kind: "continue", access, principal: null };
  }
  if (access === "proof_authenticated_public_api") {
    const requiredProof = publicProofForPath(parsed.pathname);
    if (!requiredProof) {
      throw new ServiceError({ code: "internal", message: "Public proof policy is inconsistent." });
    }
    return { kind: "continue", access, principal: null, requiredProof };
  }

  let session;
  try {
    session = await input.sessions.resolve(input.context, { headers: input.request.headers });
  } catch (error) {
    return {
      kind: "reject",
      status: httpStatusForError(error),
      body: toErrorEnvelope(error, input.context.correlation.correlationId),
    };
  }
  if (session.kind === "authenticated") {
    return { kind: "continue", access, principal: session.principal };
  }
  if (access === "private_page") {
    return { kind: "redirect", status: 307, location: loginRedirectLocation(input.request.url) };
  }

  const error = new ServiceError({
    code: "unauthenticated",
    message: "Authentication required.",
  });
  return {
    kind: "reject",
    status: 401,
    body: toErrorEnvelope(error, input.context.correlation.correlationId),
  };
}

/** Converts only terminal decisions; `null` means invoke the OpenNext handler. */
export function responseFromRequestBoundaryDecision(
  decision: RequestBoundaryDecision,
): Response | null {
  if (decision.kind === "continue") return null;
  if (decision.kind === "redirect") {
    return new Response(null, {
      status: decision.status,
      headers: { Location: decision.location, "Cache-Control": "no-store" },
    });
  }
  return Response.json(decision.body, {
    status: decision.status,
    headers: {
      "Cache-Control": "no-store",
      "X-Correlation-Id": decision.body.error.correlationId,
    },
  });
}
