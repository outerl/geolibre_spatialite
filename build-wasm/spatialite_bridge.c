// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting
#include <sqlite3.h>
#include <spatialite.h>
#include <geos_c.h>
#include <proj.h>
#include <emscripten.h>
#include <stdlib.h>

EMSCRIPTEN_KEEPALIVE void *spatialite_wasm_init(sqlite3 *db) {
    if (!db) return NULL;
    void *cache = spatialite_alloc_connection();
    if (cache) spatialite_init_ex(db, cache, 0);
    return cache;
}
EMSCRIPTEN_KEEPALIVE void spatialite_wasm_cleanup(void *cache) {
    if (cache) spatialite_cleanup_ex(cache);
}
EMSCRIPTEN_KEEPALIVE const char *spatialite_wasm_version(void) { return spatialite_version(); }
EMSCRIPTEN_KEEPALIVE int spatialite_wasm_has_geos(void) { return GEOSversion() != NULL; }
EMSCRIPTEN_KEEPALIVE int spatialite_wasm_has_proj(void) { return proj_info().major > 0; }
