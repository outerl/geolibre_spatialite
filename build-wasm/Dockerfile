# syntax=docker/dockerfile:1
# SPDX-License-Identifier: LGPL-2.1-or-later
# Copyright (c) 2026 Outer Loop Consulting
FROM emscripten/emsdk:3.1.64 AS builder
ENV SQLITE_VER=3460100 PROJ_VER=9.4.1 GEOS_VER=3.12.2 SPATIALITE_VER=5.1.0 ZLIB_VER=1.3.1
ENV SOURCE_DATE_EPOCH=1726185600
ENV PKG_CONFIG_LIBDIR=/opt/wasm/lib/pkgconfig
ENV PKG_CONFIG_PATH=/opt/wasm/lib/pkgconfig
ENV EM_PKG_CONFIG_PATH=/opt/wasm/lib/pkgconfig
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget autoconf automake autotools-dev libtool pkg-config bzip2 unzip ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN --mount=type=bind,source=.,target=/context \
    mkdir -p /dist/sources /dist/licenses /opt/wasm/lib/pkgconfig /opt/wasm/include && \
    if [ -d /context/src/wasm/sources ]; then cp -a /context/src/wasm/sources/. .; fi && \
    (test -s sqlite-amalgamation-${SQLITE_VER}.zip || wget -q https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE_VER}.zip) && \
    (test -s proj-${PROJ_VER}.tar.gz || wget -q https://download.osgeo.org/proj/proj-${PROJ_VER}.tar.gz) && \
    (test -s geos-${GEOS_VER}.tar.bz2 || wget -q https://download.osgeo.org/geos/geos-${GEOS_VER}.tar.bz2) && \
    (test -s libspatialite-${SPATIALITE_VER}.tar.gz || wget -q https://www.gaia-gis.it/gaia-sins/libspatialite-sources/libspatialite-${SPATIALITE_VER}.tar.gz) && \
    (test -s zlib-${ZLIB_VER}.tar.gz || wget -q https://zlib.net/fossils/zlib-${ZLIB_VER}.tar.gz) && \
    cp *.zip *.tar.gz *.tar.bz2 /dist/sources/ && \
    unzip -q sqlite-amalgamation-${SQLITE_VER}.zip && \
    tar -xzf proj-${PROJ_VER}.tar.gz && tar -xjf geos-${GEOS_VER}.tar.bz2 && \
    tar -xzf libspatialite-${SPATIALITE_VER}.tar.gz && tar -xzf zlib-${ZLIB_VER}.tar.gz

# Build target SQLite BEFORE PROJ/SpatiaLite. /usr/bin/sqlite3 is the host tool
# that generates proj.db; it must never be used as the target SQLite library.
RUN emcc -O3 -DSQLITE_THREADSAFE=0 -DSQLITE_ENABLE_RTREE=1 \
      -DSQLITE_ENABLE_COLUMN_METADATA=1 -DSQLITE_ENABLE_FTS5=1 \
      -c sqlite-amalgamation-${SQLITE_VER}/sqlite3.c -o sqlite3.o && \
    emar rcs /opt/wasm/lib/libsqlite3.a sqlite3.o && \
    cp sqlite-amalgamation-${SQLITE_VER}/sqlite3.h sqlite-amalgamation-${SQLITE_VER}/sqlite3ext.h /opt/wasm/include/ && \
    printf '%s\n' 'prefix=/opt/wasm' 'libdir=${prefix}/lib' 'includedir=${prefix}/include' \
      'Name: SQLite' 'Description: Target SQLite for WebAssembly' 'Version: 3.46.1' \
      'Libs: -L${libdir} -lsqlite3 -lm' 'Cflags: -I${includedir}' > /opt/wasm/lib/pkgconfig/sqlite3.pc
WORKDIR /build/zlib-${ZLIB_VER}
RUN emconfigure ./configure --static --prefix=/opt/wasm && \
    emmake make -j$(nproc) && emmake make install
WORKDIR /build/proj-${PROJ_VER}
RUN emcmake cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_CXX_FLAGS="-O3 -fexceptions" \
      -DENABLE_TIFF=OFF -DENABLE_CURL=OFF -DBUILD_APPS=OFF -DBUILD_TESTING=OFF \
      -DSQLite3_INCLUDE_DIR=/opt/wasm/include -DSQLite3_LIBRARY=/opt/wasm/lib/libsqlite3.a \
      -DEXE_SQLITE3=/usr/bin/sqlite3 -DCMAKE_INSTALL_PREFIX=/opt/wasm && \
    cmake --build build -j$(nproc) && cmake --install build
WORKDIR /build/geos-${GEOS_VER}
RUN emcmake cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_CXX_FLAGS="-O3 -fexceptions" \
      -DBUILD_DOCUMENTATION=OFF -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX=/opt/wasm && \
    cmake --build build -j$(nproc) && cmake --install build
COPY build-wasm/patch-geos-config.py /build/patch-geos-config.py
RUN python3 /build/patch-geos-config.py /opt/wasm/bin/geos-config

WORKDIR /build/libspatialite-${SPATIALITE_VER}
# SpatiaLite 5.1.0 ships an old config.sub that rejects Emscripten; refresh the
# canonical triplet helpers and check the requested host before configure runs.
# Limit SUBDIRS to src to avoid building test binaries, and omit loadable module mod_spatialite.la.
# Autoconf AC_CHECK_LIB / AC_SEARCH_LIBS probes compile dummy declarations (e.g. char inflateInit_();)
# which wasm-ld rejects as function signature mismatches against the static libraries.
# Pass cached probe results so configure detects zlib, PROJ, and GEOS without failing.
RUN cp /usr/share/misc/config.sub /usr/share/misc/config.guess . && \
    sed -i 's/^SUBDIRS = src test.*/SUBDIRS = src/' Makefile.in && \
    sed -i 's/mod_spatialite.la//g' src/Makefile.in && \
    sed -i -E 's/^noinst_LTLIBRARIES = lib([a-zA-Z0-9_]+)\.la [a-zA-Z0-9_]+\.la/noinst_LTLIBRARIES = lib\1.la/' src/*/Makefile.in && \
    ./config.sub wasm32-unknown-emscripten && \
    (ac_cv_lib_z_inflateInit_=yes \
     ac_cv_search_proj_normalize_for_visualization=-lproj \
     ac_cv_search_GEOSCoveredBy=-lgeos_c \
     ac_cv_search_GEOSDelaunayTriangulation=-lgeos_c \
     ac_cv_search_GEOSContext_setErrorMessageHandler_r=-lgeos_c \
     ac_cv_search_GEOSFrechetDistance_r=-lgeos_c \
     ac_cv_search_GEOSConstrainedDelaunayTriangulation_r=-lgeos_c \
     ac_cv_search_GEOSHilbertCode=-lgeos_c \
     emconfigure ./configure --host=wasm32-unknown-emscripten --prefix=/opt/wasm \
       --enable-shared=no --enable-static=yes --disable-rttopo --disable-freexl \
       --disable-libxml2 --disable-gcp --disable-minizip --disable-iconv \
       --disable-examples --disable-dependency-tracking \
       --with-geosconfig=/opt/wasm/bin/geos-config \
       CPPFLAGS="-I/opt/wasm/include" \
       CFLAGS="-O3 -I/opt/wasm/include -sDISABLE_EXCEPTION_CATCHING=0 -DGEOS_ADVANCED -DGEOS_370 -DGEOS_390 -DGEOS_3100 -DGEOS_3110" \
       CXXFLAGS="-O3 -fexceptions -I/opt/wasm/include" \
       LDFLAGS="-L/opt/wasm/lib -sDISABLE_EXCEPTION_CATCHING=0" \
       LIBS="-lsqlite3 -lz -lm" || (echo "=== configure failed, dumping config.log ===" && cat config.log && exit 1)) && \
    emmake make -j$(nproc) && emmake make install

WORKDIR /build
COPY build-wasm/spatialite_bridge.c /build/spatialite_bridge.c
COPY build-wasm/post.js /build/post.js
RUN emcc -O3 -I/opt/wasm/include -c spatialite_bridge.c -o spatialite_bridge.o && \
    em++ -O3 -fexceptions spatialite_bridge.o -L/opt/wasm/lib \
      -lspatialite -lgeos_c -lgeos -lproj -lsqlite3 -lworkerfs.js -lz \
      --no-entry -sWASM_BIGINT=1 -sALLOW_MEMORY_GROWTH=1 \
      -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=5242880 -sMAXIMUM_MEMORY=2147483648 \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sSINGLE_FILE=1 -sENVIRONMENT=web,worker \
      -sDISABLE_EXCEPTION_CATCHING=0 -sFORCE_FILESYSTEM=1 \
      --post-js /build/post.js \
      --embed-file /opt/wasm/share/proj/proj.db@/opt/wasm/share/proj/proj.db \
      -sEXPORTED_RUNTIME_METHODS='["getValue","setValue","UTF8ToString","FS","HEAPU8","stackSave","stackRestore","stackAlloc"]' \
      -sEXPORTED_FUNCTIONS='["_sqlite3_open","_sqlite3_open_v2","_sqlite3_close_v2","_sqlite3_prepare_v2","_sqlite3_step","_sqlite3_finalize","_sqlite3_reset","_sqlite3_clear_bindings","_sqlite3_stmt_readonly","_sqlite3_bind_parameter_count","_sqlite3_column_count","_sqlite3_column_type","_sqlite3_column_name","_sqlite3_column_text","_sqlite3_column_blob","_sqlite3_column_bytes","_sqlite3_column_double","_sqlite3_column_int64","_sqlite3_bind_null","_sqlite3_bind_text","_sqlite3_bind_blob","_sqlite3_bind_double","_sqlite3_bind_int64","_sqlite3_get_autocommit","_sqlite3_serialize","_sqlite3_free","_sqlite3_errmsg","_spatialite_wasm_init","_spatialite_wasm_cleanup","_spatialite_wasm_version","_spatialite_wasm_has_geos","_spatialite_wasm_has_proj","_malloc","_free"]' \
      -o /dist/spatialite.js && \
    cp /opt/wasm/share/proj/proj.db /dist/proj.db && \
    cp libspatialite-${SPATIALITE_VER}/COPYING /dist/licenses/libspatialite.txt && \
    cp geos-${GEOS_VER}/COPYING /dist/licenses/geos.txt && \
    cp proj-${PROJ_VER}/COPYING /dist/licenses/proj.txt && \
    cp zlib-${ZLIB_VER}/LICENSE /dist/licenses/zlib.txt
COPY build-wasm/write-build-info.py /build/write-build-info.py
RUN python3 write-build-info.py /dist
# Export the contents at the root, not under a second dist/ directory.
FROM scratch AS artifacts
COPY --from=builder /dist/ /
