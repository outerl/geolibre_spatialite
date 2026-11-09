// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import sqlWasmBase64 from "virtual:sql-wasm-base64";
import bundledNativeFactory from "virtual:spatialite-native";

import { registerSpatialFunctions } from "./spatial-functions.js";
import {
  type IDatabaseBackend,
  type IStatementBackend,
  NativeCDatabase,
  type SpatialiteWasmModule,
  type SqlValue,
} from "./c-wasm-adapter.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
let nativeWasmFactory: (() => Promise<SpatialiteWasmModule>) | null = bundledNativeFactory;
let nativeWasmModulePromise: Promise<SpatialiteWasmModule> | null = null;
let loadedNativeModule: SpatialiteWasmModule | null = null;

function decodeInlineWasm(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function loadSqliteWasm(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({ wasmBinary: decodeInlineWasm(sqlWasmBase64) });
  return sqlJsPromise.catch((error: unknown) => {
    sqlJsPromise = null;
    throw error;
  });
}

/**
 * Registers an Emscripten module factory for true native C SpatiaLite WebAssembly.
 * When registered, newly opened databases use native C libspatialite (GEOS, PROJ, VirtualSpatialIndex).
 */
export function registerNativeSpatialiteFactory(factory: (() => Promise<SpatialiteWasmModule>) | null): void {
  nativeWasmFactory = factory;
  nativeWasmModulePromise = null;
  loadedNativeModule = null;
}

export function getLoadedSpatialiteVersion(): string {
  return loadedNativeModule ? loadedNativeModule.UTF8ToString(loadedNativeModule._spatialite_wasm_version()) : "not initialized";
}

export function loadNativeSpatialiteWasm(): Promise<SpatialiteWasmModule> {
  if (!nativeWasmFactory) return Promise.reject(new Error("Native SpatiaLite is not configured."));
  const pending = nativeWasmModulePromise ??= nativeWasmFactory();
  return pending.then((mod) => {
    if (nativeWasmModulePromise === pending) loadedNativeModule = mod;
    return mod;
  }).catch((error: unknown) => {
    if (nativeWasmModulePromise === pending) nativeWasmModulePromise = null;
    throw error;
  });
}

/**
 * Returns whether the active database engine is native C WASM or inlined SQLite WASM.
 */
export function getActiveEngineType(): "native-c-wasm" | "inlined-sqlite-wasm" {
  return nativeWasmFactory ? "native-c-wasm" : "inlined-sqlite-wasm";
}

function wrapSqlJsDatabase(db: Database): IDatabaseBackend {
  return {
    isNativeC: false,
    run(sql: string, params?: SqlValue[]): void {
      db.run(sql, params as (number | string | Uint8Array | null)[]);
    },
    exec(sql: string, params?: SqlValue[]): { columns: string[]; values: SqlValue[][] }[] {
      if (params && params.length > 0) {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params as (number | string | Uint8Array | null)[]);
          const columns = stmt.getColumnNames();
          const values: SqlValue[][] = [];
          while (stmt.step()) {
            values.push(stmt.get());
          }
          return [{ columns, values }];
        } finally {
          stmt.free();
        }
      }
      return db.exec(sql);
    },
    prepare(sql: string): IStatementBackend {
      const stmt = db.prepare(sql);
      return {
        step: () => stmt.step(),
        get: () => stmt.get(),
        getAsObject: () => stmt.getAsObject(),
        getColumnNames: () => stmt.getColumnNames(),
        free: () => {
          stmt.free();
        },
        reset: () => {
          stmt.reset();
        },
        bind: (params?: SqlValue[]) => stmt.bind(params as (number | string | Uint8Array | null)[]),
      };
    },
    *iterateStatements(sql: string): IterableIterator<IStatementBackend> {
      for (const stmt of db.iterateStatements(sql)) {
        yield {
          step: () => stmt.step(),
          get: () => stmt.get(),
          getAsObject: () => stmt.getAsObject(),
          getColumnNames: () => stmt.getColumnNames(),
          free: () => {
            stmt.free();
          },
          reset: () => {
            stmt.reset();
          },
          bind: (params?: SqlValue[]) => stmt.bind(params as (number | string | Uint8Array | null)[]),
        };
      }
    },
    export(): Uint8Array {
      return db.export();
    },
    close(): void {
      db.close();
    },
    getSpatialiteVersion(): string {
      return "0.1.0 (inlined)";
    },
    hasGeos(): boolean {
      return false;
    },
    hasProj(): boolean {
      return false;
    },
  };
}

/**
 * Initializes a SpatiaLite-enabled database backend from raw SQLite file bytes or creates a new empty one.
 * If a native C SpatiaLite WASM factory is registered, uses true upstream libspatialite;
 * otherwise, falls back to the inlined SQLite WASM engine with TypeScript spatial functions.
 */
export async function createSpatialiteDatabase(data?: Uint8Array | ArrayBuffer): Promise<IDatabaseBackend> {
  if (nativeWasmFactory) {
    const mod = await loadNativeSpatialiteWasm();
    return NativeCDatabase.open(mod, data);
  }

  const SQL = await loadSqliteWasm();
  const db = data ? new SQL.Database(data instanceof Uint8Array ? data : new Uint8Array(data)) : new SQL.Database();
  try {
    db.exec("PRAGMA schema_version");
    registerSpatialFunctions(db);
    return wrapSqlJsDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
