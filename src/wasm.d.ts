/** Wrangler bundles .wasm imports as compiled modules, the only way Workers allow WebAssembly. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
