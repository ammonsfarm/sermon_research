/**
 * Bindings plus the one secret each deployment sets by hand. `wrangler types`
 * may or may not list APP_SECRET depending on local .dev.vars, so it is
 * declared here as optional either way.
 */
export type AppEnv = Omit<Env, "APP_SECRET"> & {
  /** Random 32+ character value. Proves deploy ownership during setup and encrypts stored API keys. */
  readonly APP_SECRET?: string;
};
