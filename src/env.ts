/** Bindings plus the one secret each deployment sets by hand. */
export interface AppEnv extends Env {
  /** Random 32+ character value. Proves deploy ownership during setup; later encrypts stored API keys. */
  readonly APP_SECRET?: string;
}
