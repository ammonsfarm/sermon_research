import type { RequestOperationContext } from "./execution.ts";
import type { SessionId, UserId } from "./ids.ts";

export const ROLE_NAMES = [
  "User",
  "Admin",
  "Content Manager",
  "Research User",
  "Read Only",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const CAPABILITIES = [
  "internal:read",
  "research:generate",
  "content:read",
  "content:manage",
  "audio:preview",
  "pipeline:retry",
  "users:manage",
  "settings:manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface SessionPrincipal {
  readonly kind: "user";
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly roles: readonly RoleName[];
  readonly capabilities: readonly Capability[];
  readonly expiresAt: string;
}

export type SessionResolution =
  | { readonly kind: "anonymous" }
  | { readonly kind: "authenticated"; readonly principal: SessionPrincipal }
  | { readonly kind: "invalid"; readonly reason: "expired" | "malformed" | "revoked" };

export interface SessionCredentialInput {
  readonly headers: Pick<Headers, "get">;
}

export interface SessionReader {
  resolve(
    context: RequestOperationContext,
    credentials: SessionCredentialInput,
  ): Promise<SessionResolution>;
}

export interface ResourceAuthorization {
  readonly capability: Capability;
  readonly resourceType?: "article" | "episode" | "editorial" | "user" | "settings";
  readonly resourceId?: string;
}

export type AuthorizationDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: "unauthenticated" | "forbidden" };

export interface AuthorizationService {
  decide(
    context: RequestOperationContext,
    principal: SessionPrincipal | null,
    requirement: ResourceAuthorization,
  ): Promise<AuthorizationDecision>;
}

export type RouteAccessClass =
  | "public"
  | "proof_authenticated_public_api"
  | "private_page"
  | "private_api"
  | "application_resolution";

export interface RouteAccessRequest {
  readonly method: string;
  readonly pathname: string;
}

export interface RouteAccessPolicy {
  classify(
    context: RequestOperationContext,
    request: RouteAccessRequest,
  ): Promise<RouteAccessClass>;
}

export const SIGNED_OUT_ROUTE_BEHAVIOR = {
  public: "continue",
  proof_authenticated_public_api: "continue_to_proof_verifier",
  private_page: "redirect_307_to_login_with_relative_return_url",
  private_api: "json_401_error_envelope",
  application_resolution: "continue_so_router_can_render_dynamic_page_or_404",
} as const satisfies Readonly<Record<RouteAccessClass, string>>;

export const PUBLIC_PROOF_TYPES = [
  "same_site_and_body_validation",
  "signed_unsubscribe_token",
  "shared_revalidation_secret",
  "webhook_hmac",
] as const;
export type PublicProofType = (typeof PUBLIC_PROOF_TYPES)[number];

export interface PublicRequestProofVerifier {
  verify(
    context: RequestOperationContext,
    proof: PublicProofType,
    request: { readonly headers: Pick<Headers, "get">; readonly body?: Uint8Array },
  ): Promise<boolean>;
}

export interface AuthServices {
  readonly sessions: SessionReader;
  readonly authorization: AuthorizationService;
  readonly routes: RouteAccessPolicy;
  readonly publicProofs: PublicRequestProofVerifier;
}
