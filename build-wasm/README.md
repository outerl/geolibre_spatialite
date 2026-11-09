# Native C SpatiaLite WebAssembly

Build from the repository root:

```sh
npm ci
npm run build:wasm
npm run check
npm run package:geolibre
npm run test:package
```

Docker/Buildx must be available and running. The artifact stage exports its contents directly at `src/wasm/`: the single-file `spatialite.js` module, embedded-database source `proj.db`, licenses, upstream source archives, and SHA-256 build metadata. No temporary container is created.

The module statically links SQLite, zlib, GEOS, PROJ, and libspatialite. It uses the BigInt i64 ABI and embeds the PROJ database, so it needs no runtime network requests. Production builds require these artifacts and automatically select the native engine.

For build order, flags, integration checks, source modifications, and CI artifact reuse, see [the native build documentation](../docs/c-wasm-compilation.md).
