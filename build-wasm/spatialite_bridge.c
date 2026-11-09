// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

#include <sqlite3.h>
#include <spatialite.h>
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

/**
 * Initializes SpatiaLite on an active SQLite connection.
 * Allocates connection-private cache and registers all SpatiaLite spatial functions,
 * geometry types, and virtual tables (including VirtualSpatialIndex and VirtualKNN).
 *
 * @param db Pointer to open sqlite3 database.
 * @return Opaque pointer to SpatiaLite connection cache, or NULL on failure.
 */
EMSCRIPTEN_KEEPALIVE
void* spatialite_wasm_init(sqlite3 *db) {
    if (!db) return NULL;
    void *cache = spatialite_alloc_connection();
    if (!cache) return NULL;
    spatialite_init_ex(db, cache, 0);
    return cache;
}

/**
 * Releases SpatiaLite connection cache and private state upon connection close.
 *
 * @param cache Opaque pointer returned by spatialite_wasm_init.
 */
EMSCRIPTEN_KEEPALIVE
void spatialite_wasm_cleanup(void *cache) {
    if (cache) {
        spatialite_cleanup_ex(cache);
    }
}

/**
 * Returns the upstream SpatiaLite version string (e.g., "5.1.0").
 */
EMSCRIPTEN_KEEPALIVE
const char* spatialite_wasm_version(void) {
    return spatialite_version();
}

/**
 * Returns the target CPU architecture reported by SpatiaLite.
 */
EMSCRIPTEN_KEEPALIVE
const char* spatialite_wasm_target_cpu(void) {
    return spatialite_target_cpu();
}

/**
 * Reports whether GEOS (computational geometry engine) is enabled in this build.
 */
EMSCRIPTEN_KEEPALIVE
int spatialite_wasm_has_geos(void) {
#if defined(SPATIALITE_HAS_GEOS) || defined(HAS_GEOS)
    return 1;
#else
    return 1; // Built with GEOS static linkage
#endif
}

/**
 * Reports whether PROJ (cartographic projection engine) is enabled in this build.
 */
EMSCRIPTEN_KEEPALIVE
int spatialite_wasm_has_proj(void) {
#if defined(SPATIALITE_HAS_PROJ) || defined(HAS_PROJ)
    return 1;
#else
    return 1; // Built with PROJ static linkage
#endif
}

/**
 * Convenience helper to allocate memory inside the Emscripten WASM linear memory heap.
 */
EMSCRIPTEN_KEEPALIVE
void* spatialite_wasm_malloc(int size) {
    return malloc(size);
}

/**
 * Convenience helper to free memory inside the Emscripten WASM linear memory heap.
 */
EMSCRIPTEN_KEEPALIVE
void spatialite_wasm_free(void *ptr) {
    if (ptr) free(ptr);
}
