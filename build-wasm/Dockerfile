# SPDX-License-Identifier: LGPL-2.1-or-later
# Copyright (c) 2026 Outer Loop Consulting
#
# Dockerfile for compiling true upstream C SpatiaLite, GEOS, PROJ, and SQLite
# into an optimized WebAssembly module using the Emscripten SDK.

FROM emscripten/emsdk:3.1.64 AS builder

WORKDIR /build

# Upstream pinned release versions
ENV SQLITE_VER=3460100
ENV PROJ_VER=9.4.1
ENV GEOS_VER=3.12.2
ENV SPATIALITE_VER=5.1.0

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    autoconf \
    automake \
    libtool \
    pkg-config \
    bzip2 \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 1. Download upstream source distributions
RUN echo "Downloading SQLite 3.46.1 amalgamation..." && \
    wget -q https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE_VER}.zip && \
    unzip -q sqlite-amalgamation-${SQLITE_VER}.zip

RUN echo "Downloading PROJ ${PROJ_VER}..." && \
    wget -q https://download.osgeo.org/proj/proj-${PROJ_VER}.tar.gz && \
    tar -xzf proj-${PROJ_VER}.tar.gz

RUN echo "Downloading GEOS ${GEOS_VER}..." && \
    wget -q https://download.osgeo.org/geos/geos-${GEOS_VER}.tar.bz2 && \
    tar -xjf geos-${GEOS_VER}.tar.bz2

RUN echo "Downloading SpatiaLite ${SPATIALITE_VER}..." && \
    wget -q https://www.gaia-gis.it/gaia-sins/libspatialite-sources/libspatialite-${SPATIALITE_VER}.tar.gz && \
    tar -xzf libspatialite-${SPATIALITE_VER}.tar.gz

# 2. Build PROJ static library with Emscripten
WORKDIR /build/proj-${PROJ_VER}
RUN mkdir build && cd build && \
    emcmake cmake .. \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DENABLE_TIFF=OFF \
      -DENABLE_CURL=OFF \
      -DBUILD_PROJSYNC=OFF \
      -DBUILD_APPS=OFF \
      -DBUILD_TESTING=OFF \
      -DCMAKE_INSTALL_PREFIX=/opt/wasm && \
    emmake make -j$(nproc) && \
    emmake make install

# 3. Build GEOS static library with Emscripten
WORKDIR /build/geos-${GEOS_VER}
RUN mkdir build && cd build && \
    emcmake cmake .. \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_DOCUMENTATION=OFF \
      -DBUILD_TESTING=OFF \
      -DCMAKE_INSTALL_PREFIX=/opt/wasm && \
    emmake make -j$(nproc) && \
    emmake make install

# 4. Build SpatiaLite static library with Emscripten
# Note: --disable-rttopo is mandatory to maintain LGPL-2.1 licensing.
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
      --disable-minizip \
      CFLAGS="-O3 -I/opt/wasm/include" \
      CXXFLAGS="-O3 -I/opt/wasm/include" \
      LDFLAGS="-L/opt/wasm/lib" && \
    emmake make -j$(nproc) && \
    emmake make install

# 5. Compile the unified WebAssembly module
WORKDIR /build
COPY build-wasm/spatialite_bridge.c /build/spatialite_bridge.c

RUN mkdir -p /dist && \
    emcc -O3 -flto \
      /build/sqlite-amalgamation-${SQLITE_VER}/sqlite3.c \
      /build/spatialite_bridge.c \
      -I/opt/wasm/include \
      -I/build/sqlite-amalgamation-${SQLITE_VER} \
      -L/opt/wasm/lib \
      -lspatialite -lgeos_c -lgeos -lproj \
      -DSQLITE_ENABLE_RTREE=1 \
      -DSQLITE_ENABLE_COLUMN_METADATA=1 \
      -DSQLITE_ENABLE_FTS5=1 \
      -DSQLITE_ENABLE_JSON1=1 \
      -DSQLITE_THREADSAFE=0 \
      -s WASM=1 \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s EXPORT_NAME=createSpatialiteModule \
      -s FORCE_FILESYSTEM=1 \
      -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","FS","stackSave","stackRestore","stackAlloc","allocateUTF8"]' \
      -s EXPORTED_FUNCTIONS='["_sqlite3_open","_sqlite3_close_v2","_sqlite3_exec","_sqlite3_prepare_v2","_sqlite3_step","_sqlite3_finalize","_sqlite3_reset","_sqlite3_column_count","_sqlite3_column_type","_sqlite3_column_name","_sqlite3_column_text","_sqlite3_column_blob","_sqlite3_column_bytes","_sqlite3_column_double","_sqlite3_column_int64","_sqlite3_bind_null","_sqlite3_bind_text","_sqlite3_bind_blob","_sqlite3_bind_double","_sqlite3_bind_int64","_sqlite3_errmsg","_sqlite3_changes","_sqlite3_total_changes","_spatialite_wasm_init","_spatialite_wasm_cleanup","_spatialite_wasm_version","_spatialite_wasm_target_cpu","_spatialite_wasm_has_geos","_spatialite_wasm_has_proj","_spatialite_wasm_malloc","_spatialite_wasm_free","_malloc","_free"]' \
      -o /dist/spatialite.js

# Target image containing only the output artifacts
FROM scratch AS artifacts
COPY --from=builder /dist/spatialite.js /dist/spatialite.js
COPY --from=builder /dist/spatialite.wasm /dist/spatialite.wasm
