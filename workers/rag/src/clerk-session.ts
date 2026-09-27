import { createClerkClient } from "@clerk/backend";
import { D1UserAccessRepository, type D1Database } from "@aic/db";
import {
  RepositoryBackedSessionReader,
  type SessionVerifier,
  type VerifiedSession,
} from "@aic/auth";
import {
  isServiceError,
  ServiceError,
  type RequestOperationContext,
  type SessionId,
  type SessionReader,
  type UserAccessRepository,
  type UserId,
} from "@aic/contracts";

export type RuntimeBindings = object & {
  readonly AIC_DB?: unknown;
};

export type ClerkWorkerConfiguration = {
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly jwtKey: string;
  readonly authorizedParties: readonly string[];
};

function bindingValue(bindings: RuntimeBindings, key: string): unknown {
  return Reflect.get(bindings, key);
}

function bindingString(bindings: RuntimeBindings, key: string): string {
  const value = bindingValue(bindings, key);
  return typeof value === "string" ? value.trim() : "";
}

function parseAuthorizedParties(value: string): readonly string[] {
  return [...new Set(value.split(",").map((party) => party.trim()).filter(Boolean))];
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && (
      url.protocol === "https:"
      || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function normalizePem(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

export function readClerkWorkerConfiguration(
  bindings: RuntimeBindings,
): ClerkWorkerConfiguration | null {
  const publishableKeyAlias = bindingString(bindings, "CLERK_PUBLISHABLE_KEY");
  const publicPublishableKey = bindingString(bindings, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  if (publishableKeyAlias && publicPublishableKey && publishableKeyAlias !== publicPublishableKey) {
    return null;
  }
  const publishableKey = publicPublishableKey || publishableKeyAlias;
  const secretKey = bindingString(bindings, "CLERK_SECRET_KEY");
  const jwtKey = normalizePem(bindingString(bindings, "CLERK_JWT_KEY"));
  const authorizedParties = parseAuthorizedParties(
    bindingString(bindings, "AIC_CLERK_AUTHORIZED_PARTIES"),
  );

  if (
    !publishableKey
    || !secretKey
    || !jwtKey
    || authorizedParties.length === 0
    || authorizedParties.some((party) => !validOrigin(party))
  ) {
    return null;
  }

  return { publishableKey, secretKey, jwtKey, authorizedParties };
}

export function hasClerkSessionCredential(headers: Pick<Headers, "get">): boolean {
  const authorization = headers.get("authorization")?.trim() ?? "";
  if (/^Bearer\s+\S+$/i.test(authorization)) return true;
  const cookie = headers.get("cookie") ?? "";
  return /(?:^|;\s*)__session(?:_[A-Za-z0-9_-]+)?=/.test(cookie);
}

function invalidReason(reason: string | null): "expired" | "malformed" | "revoked" {
  if (reason?.includes("expired")) return "expired";
  if (reason?.includes("revoked")) return "revoked";
  return "malformed";
}

type ClerkAuthenticationState = Awaited<ReturnType<ReturnType<typeof createClerkClient>["authenticateRequest"]>>;
type ClerkAuthenticator = (
  request: Request,
  configuration: ClerkWorkerConfiguration,
) => Promise<ClerkAuthenticationState>;

const authenticateWithClerk: ClerkAuthenticator = async (request, configuration) => {
  const client = createClerkClient({
    publishableKey: configuration.publishableKey,
    secretKey: configuration.secretKey,
    jwtKey: configuration.jwtKey,
    telemetry: { disabled: true },
  });
  return client.authenticateRequest(request, {
    acceptsToken: "session_token",
    authorizedParties: [...configuration.authorizedParties],
    jwtKey: configuration.jwtKey,
  });
};

export class ClerkBackendSessionVerifier implements SessionVerifier {
  readonly #request: Request;
  readonly #configuration: ClerkWorkerConfiguration | null;
  readonly #authenticate: ClerkAuthenticator;

  constructor(
    request: Request,
    configuration: ClerkWorkerConfiguration | null,
    authenticate: ClerkAuthenticator = authenticateWithClerk,
  ) {
    this.#request = request;
    this.#configuration = configuration;
    this.#authenticate = authenticate;
  }

  async verify(
    context: RequestOperationContext,
    credentials: { readonly headers: Pick<Headers, "get"> },
  ): Promise<VerifiedSession> {
    if (!hasClerkSessionCredential(credentials.headers)) return { kind: "anonymous" };
    if (!this.#configuration) {
      throw new ServiceError({
        code: "dependency_unavailable",
        message: "Authentication is temporarily unavailable.",
        retryable: true,
      });
    }

    try {
      if (context.signal.aborted) {
        throw isServiceError(context.signal.reason)
          ? context.signal.reason
          : new ServiceError({ code: "cancelled", message: "The request was cancelled." });
      }
      let removeAbortListener: () => void = () => undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(isServiceError(context.signal.reason)
          ? context.signal.reason
          : new ServiceError({ code: "cancelled", message: "The request was cancelled." }));
        context.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => context.signal.removeEventListener("abort", onAbort);
      });
      let state: ClerkAuthenticationState;
      try {
        state = await Promise.race([
          this.#authenticate(this.#request, this.#configuration),
          aborted,
        ]);
      } finally {
        removeAbortListener();
      }
      if (!state.isAuthenticated) {
        return { kind: "invalid", reason: invalidReason(state.reason) };
      }

      const auth = state.toAuth();
      const expiresAtSeconds = Number(auth.sessionClaims.exp);
      if (!auth.userId || !auth.sessionId || !Number.isSafeInteger(expiresAtSeconds)) {
        return { kind: "invalid", reason: "malformed" };
      }
      console.log(`[AUTH] Authenticated Clerk user: ${auth.userId}`);
      return {
        kind: "authenticated",
        userId: auth.userId as UserId,
        sessionId: auth.sessionId as SessionId,
        expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
      };
    } catch (error) {
      if (isServiceError(error) && (error.code === "cancelled" || error.code === "timeout")) throw error;
      if (context.signal.aborted && isServiceError(context.signal.reason)) throw context.signal.reason;
      // Configuration, crypto, and provider failures must not escape as a
      // generic 500. The outer boundary translates this retryable error to a
      // correlated 503 while keeping Clerk details out of the response.
      throw new ServiceError({
        code: "dependency_unavailable",
        message: "Authentication is temporarily unavailable.",
        retryable: true,
        cause: error,
      });
    }
  }
}

function createAccessRepository(bindings: RuntimeBindings): UserAccessRepository {
  const database = bindingValue(bindings, "AIC_DB");
  if (!database || typeof database !== "object" || typeof Reflect.get(database, "prepare") !== "function") {
    return {
      async getByUserId() {
        throw new ServiceError({
          code: "dependency_unavailable",
          message: "Authoritative user access is temporarily unavailable.",
          retryable: true,
        });
      },
    };
  }
  return new D1UserAccessRepository({ db: database as D1Database });
}

export function createWorkerAdmissionSessionReader(
  request: Request,
  bindings: RuntimeBindings,
  options: { readonly requireAccessRecord?: boolean } = {},
): SessionReader {
  return new RepositoryBackedSessionReader({
    verifier: new ClerkBackendSessionVerifier(
      request,
      readClerkWorkerConfiguration(bindings),
    ),
    access: createAccessRepository(bindings),
    ...(options.requireAccessRecord === undefined ? {} : { requireAccessRecord: options.requireAccessRecord }),
  });
}
