// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { describe, expect, it, vi } from "vitest";
import { NativeCDatabase, type SpatialiteWasmModule } from "../src/spatialite/c-wasm-adapter.js";
import { SpatialiteDatabase } from "../src/spatialite/database.js";
import { getActiveEngineType, registerNativeSpatialiteFactory } from "../src/spatialite/sqlite-engine.js";
import { getSpatialiteService } from "../src/api/service.js";

interface MockSpies {
  mod: SpatialiteWasmModule;
  writeFileSpy: ReturnType<typeof vi.fn>;
  openSpy: ReturnType<typeof vi.fn>;
  initSpy: ReturnType<typeof vi.fn>;
  cleanupSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
  unlinkSpy: ReturnType<typeof vi.fn>;
}

function createMockWasmModule(): MockSpies {
  const heap = new Uint8Array(1024 * 1024);
  const vfs = new Map<string, Uint8Array>();
  let memPtr = 1000;

  const writeFileSpy = vi.fn((path: string, data: Uint8Array) => {
    vfs.set(path, new Uint8Array(data));
  });
  const readFileSpy = vi.fn((path: string) => vfs.get(path) || new Uint8Array([0x53, 0x51, 0x4c]));
  const unlinkSpy = vi.fn((path: string) => {
    vfs.delete(path);
  });
  const openSpy = vi.fn(() => 0);
  const closeSpy = vi.fn(() => 0);
  const initSpy = vi.fn(() => 777);
  const cleanupSpy = vi.fn();

  const mod: SpatialiteWasmModule = {
    getValue: vi.fn((ptr: number) => ptr + 10),
    setValue: vi.fn(),
    UTF8ToString: vi.fn((ptr: number) => (ptr === 999 ? "5.1.0" : ptr === 888 ? "name" : "")),
    allocateUTF8: vi.fn((str: string) => {
      const p = memPtr;
      memPtr += str.length + 1;
      return p;
    }),
    stackSave: vi.fn(() => 500),
    stackRestore: vi.fn(),
    stackAlloc: vi.fn((size: number) => {
      const p = memPtr;
      memPtr += size;
      return p;
    }),
    _malloc: vi.fn((size: number) => {
      const p = memPtr;
      memPtr += size;
      return p;
    }),
    _free: vi.fn(),
    FS: {
      writeFile: writeFileSpy,
      readFile: readFileSpy,
      unlink: unlinkSpy,
    },
    _sqlite3_open: openSpy,
    _sqlite3_close_v2: closeSpy,
    _sqlite3_exec: vi.fn(() => 0),
    _sqlite3_prepare_v2: vi.fn((_db: number, _sql: number, _n: number, ppStmt: number) => {
      heap[ppStmt] = 42;
      return 0;
    }),
    _sqlite3_step: vi.fn()
      .mockReturnValueOnce(100) // SQLITE_ROW
      .mockReturnValueOnce(101), // SQLITE_DONE
    _sqlite3_finalize: vi.fn(() => 0),
    _sqlite3_reset: vi.fn(() => 0),
    _sqlite3_column_count: vi.fn(() => 1),
    _sqlite3_column_type: vi.fn(() => 3), // SQLITE_TEXT
    _sqlite3_column_name: vi.fn(() => 888),
    _sqlite3_column_text: vi.fn(() => 999),
    _sqlite3_column_blob: vi.fn(() => 0),
    _sqlite3_column_bytes: vi.fn(() => 0),
    _sqlite3_column_double: vi.fn(() => 42.0),
    _sqlite3_column_int64: vi.fn(() => 42),
    _sqlite3_bind_null: vi.fn(() => 0),
    _sqlite3_bind_text: vi.fn(() => 0),
    _sqlite3_bind_blob: vi.fn(() => 0),
    _sqlite3_bind_double: vi.fn(() => 0),
    _sqlite3_bind_int64: vi.fn(() => 0),
    _sqlite3_errmsg: vi.fn(() => 0),
    _sqlite3_changes: vi.fn(() => 1),
    _spatialite_wasm_init: initSpy,
    _spatialite_wasm_cleanup: cleanupSpy,
    _spatialite_wasm_version: vi.fn(() => 999),
    _spatialite_wasm_target_cpu: vi.fn(() => 888),
    _spatialite_wasm_has_geos: vi.fn(() => 1),
    _spatialite_wasm_has_proj: vi.fn(() => 1),
  };

  return {
    mod,
    writeFileSpy,
    openSpy,
    initSpy,
    cleanupSpy,
    closeSpy,
    unlinkSpy,
  };
}

describe("Native C SpatiaLite WASM Adapter & Engine", () => {
  it("initializes native C database, mounts file, and queries version", () => {
    const { mod, writeFileSpy, openSpy, initSpy, cleanupSpy, closeSpy, unlinkSpy } = createMockWasmModule();
    const initialData = new Uint8Array([1, 2, 3]);
    const nativeDb = NativeCDatabase.open(mod, initialData);

    expect(writeFileSpy).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalled();
    expect(initSpy).toHaveBeenCalled();
    expect(nativeDb.isNativeC).toBe(true);
    expect(nativeDb.getSpatialiteVersion()).toBe("5.1.0");
    expect(nativeDb.hasGeos()).toBe(true);
    expect(nativeDb.hasProj()).toBe(true);

    const exported = nativeDb.export();
    expect(exported.length).toBeGreaterThan(0);

    nativeDb.close();
    expect(cleanupSpy).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalled();
  });

  it("plugs native WASM factory into service and sqlite-engine", async () => {
    const { mod } = createMockWasmModule();
    registerNativeSpatialiteFactory(() => Promise.resolve(mod));
    expect(getActiveEngineType()).toBe("native-c-wasm");

    const service = getSpatialiteService();
    expect(service.getEngineType()).toBe("native-c-wasm");
    expect(service.getSpatialiteVersion()).toBe("5.1.0");

    const db = await SpatialiteDatabase.open();
    expect(db.isNativeC).toBe(true);
    expect(db.getSpatialiteVersion()).toBe("5.1.0");
    expect(db.hasGeos()).toBe(true);
    expect(db.hasProj()).toBe(true);

    db.close();

    // Reset factory to test inlined engine mode
    registerNativeSpatialiteFactory(null as unknown as () => Promise<SpatialiteWasmModule>);
    expect(getActiveEngineType()).toBe("inlined-sqlite-wasm");
  });
});
