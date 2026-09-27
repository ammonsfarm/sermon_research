import {
  ServiceError,
  type RequestOperationContext,
  type SessionCredentialInput,
  type SessionId,
  type SessionReader,
  type SessionResolution,
  type UserAccessRepository,
  type UserId,
} from "@aic/contracts";

import { capabilitiesForRoles, normalizeRole, normalizeRoles } from "./roles.ts";

export type VerifiedSession =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "authenticated";
      readonly userId: UserId;
      readonly sessionId: SessionId;
      readonly expiresAt: string;
    }
  | { readonly kind: "invalid"; readonly reason: "expired" | "malformed" | "revoked" };

/** Provider SDKs, cookies, and tokens stay inside this implementation seam. */
export interface SessionVerifier {
  verify(
    context: RequestOperationContext,
    credentials: SessionCredentialInput,
  ): Promise<VerifiedSession>;
}

export interface SessionReaderOptions {
  readonly verifier: SessionVerifier;
  readonly access: UserAccessRepository;
  readonly now?: () => number;
  /** Require an authoritative access record instead of the web bootstrap User role. */
  readonly requireAccessRecord?: boolean;
}

export class RepositoryBackedSessionReader implements SessionReader {
  readonly #verifier: SessionVerifier;
  readonly #access: UserAccessRepository;
  readonly #now: () => number;
  readonly #requireAccessRecord: boolean;

  constructor(options: SessionReaderOptions) {
    this.#verifier = options.verifier;
    this.#access = options.access;
    this.#now = options.now ?? Date.now;
    this.#requireAccessRecord = options.requireAccessRecord ?? false;
  }

  async resolve(
    context: RequestOperationContext,
    credentials: SessionCredentialInput,
  ): Promise<SessionResolution> {
    const verified = await this.#verifier.verify(context, credentials);
    if (verified.kind !== "authenticated") return verified;

    const expiry = Date.parse(verified.expiresAt);
    if (!Number.isFinite(expiry)) return { kind: "invalid", reason: "malformed" };
    if (expiry <= this.#now()) return { kind: "invalid", reason: "expired" };

    const access = await this.#access.getByUserId(context, verified.userId);
    if (access === null && this.#requireAccessRecord) return { kind: "invalid", reason: "revoked" };
    if (access?.disabled) return { kind: "invalid", reason: "revoked" };

    // Repository implementations must not be able to turn malformed role
    // data into the harmless-looking default User role. D1 validates this at
    // its provider boundary too; keep the session seam fail-closed for any
    // alternate or test implementation that violates the runtime contract.
    if (access && (!Array.isArray(access.roles) || access.roles.some((role) => normalizeRole(role) === null))) {
      throw new ServiceError({
        code: "dependency_unavailable",
        message: "Authoritative user access is temporarily unavailable.",
        retryable: true,
      });
    }

    // The imported app grants a newly authenticated identity only the safe
    // default User role. Role creation remains an explicit repository concern.
    const roles = normalizeRoles(access?.roles ?? ["User"]);
    const effectiveRoles = roles.length > 0 ? roles : (["User"] as const);
    return {
      kind: "authenticated",
      principal: {
        kind: "user",
        userId: verified.userId,
        sessionId: verified.sessionId,
        roles: effectiveRoles,
        capabilities: capabilitiesForRoles(effectiveRoles),
        expiresAt: verified.expiresAt,
      },
    };
  }
}
