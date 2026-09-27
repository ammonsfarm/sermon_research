import type {
  AuthServices,
  RequestOperationContext,
  SessionPrincipal,
  UserAccessRepository,
} from "@aic/contracts";

import {
  PortableRouteAccessPolicy,
  RepositoryBackedSessionReader,
  RoleAuthorizationService,
  type SessionVerifier,
} from "../src/index.ts";

declare const verifier: SessionVerifier;
declare const access: UserAccessRepository;
declare const publicProofs: AuthServices["publicProofs"];

const services: AuthServices = {
  sessions: new RepositoryBackedSessionReader({ verifier, access }),
  authorization: new RoleAuthorizationService(),
  routes: new PortableRouteAccessPolicy(),
  publicProofs,
};
void services;

declare const context: RequestOperationContext;
declare const principal: SessionPrincipal;
void context;

// Provider/session material cannot cross the principal contract.
// @ts-expect-error SessionPrincipal deliberately has no token.
principal.token;
// @ts-expect-error SessionPrincipal deliberately has no email authorization key.
principal.email;
