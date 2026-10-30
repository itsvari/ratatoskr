declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.bin" {
  const font: ArrayBuffer;
  export default font;
}

declare module "*?url" {
  const url: string;
  export default url;
}
