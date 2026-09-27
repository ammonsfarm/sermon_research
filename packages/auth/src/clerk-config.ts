export const CLERK_CONFIGURATION_CONTRACT = {
  clientPublishableKey: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  serverPublishableKey: "CLERK_PUBLISHABLE_KEY",
  secretKey: "CLERK_SECRET_KEY",
  jwtKey: "CLERK_JWT_KEY",
  authorizedParties: "AIC_CLERK_AUTHORIZED_PARTIES",
} as const;

export interface ClerkConfigurationInput {
  readonly clientPublishableKey?: string;
  readonly serverPublishableKey?: string;
  readonly secretKey?: string;
  readonly jwtKey?: string;
  readonly authorizedParties?: readonly string[];
  readonly signInPath?: string;
  readonly signUpEnabled?: boolean;
}

export interface ClerkConfigurationAssessment {
  readonly ready: boolean;
  readonly missing: readonly (keyof typeof CLERK_CONFIGURATION_CONTRACT)[];
  readonly invalid: readonly (
    | "publishableKeys"
    | "authorizedParties"
    | "signInPath"
    | "signUpEnabled"
  )[];
  readonly signInPath: "/login";
  readonly signUpEnabled: false;
  readonly networklessVerificationConfigured: boolean;
}

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function isAuthorizedParty(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      && url.origin === value
    );
  } catch {
    return false;
  }
}

/** Returns readiness labels only; it never returns or logs configuration values. */
export function assessClerkConfiguration(
  input: ClerkConfigurationInput,
): ClerkConfigurationAssessment {
  const missing: (keyof typeof CLERK_CONFIGURATION_CONTRACT)[] = [];
  if (!configured(input.clientPublishableKey)) missing.push("clientPublishableKey");
  if (!configured(input.secretKey)) missing.push("secretKey");
  if (!configured(input.jwtKey)) missing.push("jwtKey");
  if (!input.authorizedParties?.length) missing.push("authorizedParties");

  const invalid: ClerkConfigurationAssessment["invalid"][number][] = [];
  if (
    configured(input.clientPublishableKey)
    && configured(input.serverPublishableKey)
    && input.clientPublishableKey!.trim() !== input.serverPublishableKey!.trim()
  ) {
    invalid.push("publishableKeys");
  }
  if (input.authorizedParties?.some((origin) => !isAuthorizedParty(origin))) invalid.push("authorizedParties");
  if ((input.signInPath ?? "/login") !== "/login") invalid.push("signInPath");
  if (input.signUpEnabled === true) invalid.push("signUpEnabled");

  return {
    ready: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    signInPath: "/login",
    signUpEnabled: false,
    networklessVerificationConfigured: configured(input.jwtKey),
  };
}
