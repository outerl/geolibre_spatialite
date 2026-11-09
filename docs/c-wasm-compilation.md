# Compiling Upstream C `libspatialite` to WebAssembly

This document provides the recipe and build instructions for compiling the upstream C libraries (`libspatialite`, `geos`, `proj`, and `sqlite3`) into WebAssembly using Emscripten.

While `geolibre-spatialite` includes a high-performance inlined SQLite WASM engine with built-in SpatiaLite spatial functions, advanced users or custom builds requiring the full C `libspatialite` extension can use this workflow.

---

## 1. Licensing Considerations During Compilation

When building `libspatialite`:
- **`libspatialite`** is tri-licensed (MPL 1.1 / LGPL 2.1+ / GPL 2.0+).
- **`librttopo`** is strictly **GPL v2+**.
  - **Important**: To retain an **LGPL v2.1** license and avoid forcing GPL on the binary, compile with `--disable-rttopo`.
- **`freexl`** is for Excel file reading; compile with `--disable-freexl` to reduce binary size.

---

## 2. Dockerfile for Emscripten Build

Create `Dockerfile.wasm`:

```dockerfile
FROM emscripten/emsdk:3.1.64

WORKDIR /build

# 1. Download and extract upstream sources
ENV SQLITE_VER=3460100
ENV PROJ_VER=9.4.1
ENV GEOS_VER=3.12.2
ENV SPATIALITE_VER=5.1.0

RUN apt-get update && apt-get install -y wget autoconf libtool pkg-config

# SQLite3 amalgamation
RUN wget https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE_VER}.zip && \
    unzip sqlite-amalgamation-${SQLITE_VER}.zip

# PROJ
RUN wget https://download.osgeo.org/proj/proj-${PROJ_VER}.tar.gz && \
    tar -xzf proj-${PROJ_VER}.tar.gz

# GEOS
RUN wget https://download.osgeo.org/geos/geos-${GEOS_VER}.tar.bz2 && \
    tar -xjf geos-${GEOS_VER}.tar.bz2

# SpatiaLite
RUN wget https://www.gaia-gis.it/gaia-sins/libspatialite-sources/libspatialite-${SPATIALITE_VER}.tar.gz && \
    tar -xzf libspatialite-${SPATIALITE_VER}.tar.gz

# 2. Build PROJ (static library)
WORKDIR /build/proj-${PROJ_VER}
RUN mkdir build && cd build && \
    emcmake cmake .. \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DENABLE_TIFF=OFF \
      -DENABLE_CURL=OFF \
      -DBUILD_PROJSYNC=OFF \
      -DBUILD_APPS=OFF \
      -DCMAKE_INSTALL_PREFIX=/opt/wasm && \
    emmake make -j$(nproc) && \
    emmake make install

# 3. Build GEOS (static library)
WORKDIR /build/geos-${GEOS_VER}
RUN mkdir build && cd build && \
    emcmake cmake .. \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_DOCUMENTATION=OFF \
      -DCMAKE_INSTALL_PREFIX=/opt/wasm && \
    emmake make -j$(nproc) && \
    emmake make install

# 4. Build SpatiaLite (static library)
WORKDIR /build/libspatialite-${SPATIALITE_VER}
RUN emconfigure ./configure \
      --host=wasm32-unknown-emscripten \
      --prefix=/opt/wasm \
      --enable-shared=no \
      --enable-static=yes \
      --disable-rttopo \
      --disable-freexl \
      --disable-libxml2 \
      --disable-gcp \
      CFLAGS="-O3 -I/opt/wasm/include" \
      LDFLAGS="-L/opt/wasm/lib" && \
    emmake make -j$(nproc) && \
    emmake make install

# 5. Compile combined SQLite + SpatiaLite WASM module
WORKDIR /build
RUN emcc -O3 -flto \
    /build/sqlite-amalgamation-${SQLITE_VER}/sqlite3.c \
    -I/opt/wasm/include \
    -L/opt/wasm/lib \
    -lspatialite -lgeos_c -lgeos -lproj \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap"]' \
    -s EXPORTED_FUNCTIONS='["_sqlite3_open", "_sqlite3_close", "_sqlite3_exec", "_spatialite_init"]' \
    -o spatialite.js
```

---

## 3. Running the Build

```bash
# Build the container
docker build -t spatialite-wasm-builder -f Dockerfile.wasm .

# Copy out the compiled WASM bundle
docker create --name spatialite-temp spatialite-wasm-builder
docker cp spatialite-temp:/build/spatialite.js ./dist/
docker cp spatialite-temp:/build/spatialite.wasm ./dist/
docker rm spatialite-temp
```

This generates `spatialite.wasm` statically linked with `libspatialite`, `geos`, and `proj`.
