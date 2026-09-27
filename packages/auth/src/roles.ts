import {
  CAPABILITIES,
  ROLE_NAMES,
  type AuthorizationDecision,
  type AuthorizationService,
  type Capability,
  type ResourceAuthorization,
  type RoleName,
  type SessionPrincipal,
} from "@aic/contracts";

/**
 * Derived from the imported P0 authorization helpers and navigation gates.
 * Keep this as the only role-to-capability mapping used by new integrations.
 */
export const ROLE_CAPABILITIES = {
  User: [],
  Admin: [
    "internal:read",
    "research:generate",
    "content:read",
    "content:manage",
    "audio:preview",
    "pipeline:retry",
    "users:manage",
    "settings:manage",
  ],
  "Content Manager": [
    "internal:read",
    "research:generate",
    "content:read",
    "content:manage",
    "audio:preview",
  ],
  "Research User": ["internal:read", "research:generate"],
  "Read Only": ["internal:read"],
} as const satisfies Readonly<Record<RoleName, readonly Capability[]>>;

const ROLE_ALIASES = new Map<string, RoleName>([
  ["admin", "Admin"],
  ["administrator", "Admin"],
  ["user", "User"],
  ["content manager", "Content Manager"],
  ["content_manager", "Content Manager"],
  ["contentmanager", "Content Manager"],
  ["research user", "Research User"],
  ["research_user", "Research User"],
  ["researcher", "Research User"],
  ["read only", "Read Only"],
  ["read_only", "Read Only"],
  ["readonly", "Read Only"],
  ["viewer", "Read Only"],
]);

export function normalizeRole(value: unknown): RoleName | null {
  if (typeof value !== "string") return null;
  return ROLE_ALIASES.get(value.trim().toLowerCase()) ?? null;
}

export function normalizeRoles(values: readonly unknown[]): readonly RoleName[] {
  const normalized = new Set<RoleName>();
  for (const value of values) {
    const role = normalizeRole(value);
    if (role) normalized.add(role);
  }
  return ROLE_NAMES.filter((role) => normalized.has(role));
}

export function capabilitiesForRoles(roles: readonly RoleName[]): readonly Capability[] {
  const granted = new Set<Capability>();
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role]) granted.add(capability);
  }
  return CAPABILITIES.filter((capability) => granted.has(capability));
}

export function hasCapability(
  principal: SessionPrincipal | null,
  capability: Capability,
): boolean {
  return principal?.capabilities.includes(capability) ?? false;
}

export class RoleAuthorizationService implements AuthorizationService {
  async decide(
    _context: Parameters<AuthorizationService["decide"]>[0],
    principal: SessionPrincipal | null,
    requirement: ResourceAuthorization,
  ): Promise<AuthorizationDecision> {
    if (!principal) return { kind: "deny", reason: "unauthenticated" };
    return hasCapability(principal, requirement.capability)
      ? { kind: "allow" }
      : { kind: "deny", reason: "forbidden" };
  }
}
