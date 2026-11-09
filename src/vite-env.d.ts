/// <reference types="vite/client" />

declare module "virtual:sql-wasm-base64" {
  const base64: string;
  export default base64;
}

declare module "virtual:spatialite-native" {
  import type { SpatialiteWasmModule } from "./spatialite/c-wasm-adapter.js";
  const factory: (() => Promise<SpatialiteWasmModule>) | null;
  export default factory;
}
