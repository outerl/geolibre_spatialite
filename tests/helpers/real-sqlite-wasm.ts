// SPDX-License-Identifier: LGPL-2.1-or-later
// Exercise the adapter against a real SQLite C engine. sql.js does not publicly
// export every C symbol; the few missing symbols below marshal through its API.
// Full ABI/SpatiaLite/GEOS/PROJ/WAL tests run separately on the compiled artifact.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import initSqlJs, { type Database } from "sql.js";
import type { SpatialiteWasmModule } from "../../src/spatialite/c-wasm-adapter.js";

type RawExports = Pick<SpatialiteWasmModule,
  "_malloc" | "_free" | "UTF8ToString" | "stackSave" | "stackRestore" | "stackAlloc" |
  "_sqlite3_prepare_v2" | "_sqlite3_step" | "_sqlite3_finalize" | "_sqlite3_reset" |
  "_sqlite3_clear_bindings" | "_sqlite3_column_count" | "_sqlite3_column_type" |
  "_sqlite3_column_name" | "_sqlite3_column_text" | "_sqlite3_column_blob" |
  "_sqlite3_column_bytes" | "_sqlite3_column_double" | "_sqlite3_bind_double" |
  "_sqlite3_bind_text" | "_sqlite3_bind_blob" | "_sqlite3_errmsg"
> & { _sqlite3_bind_int(stmt: number, col: number, value: number): number; _sqlite3_sql(stmt: number): number };

export async function createRealSqliteModule(): Promise<{
  mod: SpatialiteWasmModule;
  allocations: Set<number>;
  files: Map<string, Uint8Array>;
  workerFsMounts: Map<string, { blobs: { name: string; data: Blob }[] }>;
  openFlags: number[];
  close: () => void;
}> {
  const require = createRequire(`${process.cwd()}/package.json`);
  const bytes = await readFile(require.resolve("sql.js/dist/sql-wasm.wasm"));
  let captured: WebAssembly.Memory | undefined;
  const config = {
    wasmBinary: new Uint8Array(bytes).buffer,
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, compiled: WebAssembly.Module) => void): WebAssembly.Exports {
      const compiled = new WebAssembly.Module(bytes);
      const instance = new WebAssembly.Instance(compiled, imports);
      const name = WebAssembly.Module.exports(compiled).find((entry) => entry.kind === "memory")?.name;
      const memory = name ? instance.exports[name] : undefined;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("SQLite memory was not exported.");
      captured = memory; done(instance, compiled); return instance.exports;
    },
  };
  const SQL = await initSqlJs(config);
  if (!captured) throw new Error("SQLite WASM did not initialize.");
  const memory = captured;
  const raw = SQL as unknown as RawExports;
  const allocations = new Set<number>(), files = new Map<string, Uint8Array>();
  const workerFsMounts = new Map<string, { blobs: { name: string; data: Blob }[] }>(), openFlags: number[] = [];
  const owners = new Map<number, Database>(), stmtOwners = new Map<number, number>(), transactions = new Set<number>();
  const text = (str: string): number => {
    const bytes = new TextEncoder().encode(str), ptr = raw._malloc(bytes.length + 1);
    const heap = new Uint8Array(memory.buffer); heap.set(bytes, ptr); heap[ptr + bytes.length] = 0;
    return ptr;
  };
  const versionPtr = text("5.1.0 (SQLite test bridge)");
  const mod: SpatialiteWasmModule = {
    ...raw,
    get HEAPU8() { return new Uint8Array(memory.buffer); },
    getValue: (ptr) => new DataView(memory.buffer).getInt32(ptr, true),
    setValue: (ptr, value) => { new DataView(memory.buffer).setInt32(ptr, value, true); },
    _malloc(size) { const ptr = raw._malloc(size); allocations.add(ptr); return ptr; },
    _free(ptr) { allocations.delete(ptr); raw._free(ptr); },
    _sqlite3_free(ptr) { allocations.delete(ptr); raw._free(ptr); },
    FS: {
      mkdirTree() {}, writeFile(path, data) { files.set(path, data.slice()); },
      readFile(path) { return files.get(path)?.slice() ?? new Uint8Array(); },
      unlink(path) { files.delete(path); },
      mount(_type, options, mountpoint) { workerFsMounts.set(mountpoint, options); },
      unmount(mountpoint) { workerFsMounts.delete(mountpoint); },
    },
    WORKERFS: {},
    _sqlite3_open(path, out) {
      const owner = new SQL.Database(files.get(raw.UTF8ToString(path)));
      const ptr = (owner as unknown as { db: number }).db;
      owners.set(ptr, owner); mod.setValue(out, ptr, "*"); return 0;
    },
    _sqlite3_open_v2(path, out, flags) {
      openFlags.push(flags);
      if (flags !== 1) { mod.setValue(out, 0, "*"); return 8; }
      const filename = raw.UTF8ToString(path);
      for (const [mountpoint, mount] of workerFsMounts) {
        const prefix = `${mountpoint}/`;
        if (!filename.startsWith(prefix)) continue;
        const blob = mount.blobs.find((entry) => `${prefix}${entry.name}` === filename)?.data as (Blob & { nativeTestBytes?: Uint8Array }) | undefined;
        const bytes = blob?.nativeTestBytes;
        if (!bytes) { mod.setValue(out, 0, "*"); return 14; }
        try {
          const owner = new SQL.Database(bytes);
          const ptr = (owner as unknown as { db: number }).db;
          owners.set(ptr, owner); mod.setValue(out, ptr, "*"); return 0;
        } catch {
          mod.setValue(out, 0, "*"); return 26;
        }
      }
      mod.setValue(out, 0, "*"); return 14;
    },
    _sqlite3_close_v2(ptr) { owners.get(ptr)?.close(); owners.delete(ptr); transactions.delete(ptr); return 0; },
    _sqlite3_prepare_v2(db, sql, n, out, tail) {
      const rc = raw._sqlite3_prepare_v2(db, sql, n, out, tail);
      const ptr = mod.getValue(out, "*"); if (ptr) stmtOwners.set(ptr, db); return rc;
    },
    _sqlite3_finalize(ptr) { stmtOwners.delete(ptr); return raw._sqlite3_finalize(ptr); },
    _sqlite3_step(ptr) {
      const sql = raw.UTF8ToString(raw._sqlite3_sql(ptr)).trim();
      const rc = raw._sqlite3_step(ptr), db = stmtOwners.get(ptr);
      if (db !== undefined && rc === 101) {
        if (/^(BEGIN|SAVEPOINT)\b/i.test(sql)) transactions.add(db);
        if (/^(COMMIT|END|RELEASE|ROLLBACK(?!\s+TO))\b/i.test(sql)) transactions.delete(db);
      }
      return rc;
    },
    _sqlite3_bind_parameter_count(ptr) {
      const sql = raw.UTF8ToString(raw._sqlite3_sql(ptr)).replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, "");
      return (sql.match(/\?/g) ?? []).length;
    },
    _sqlite3_stmt_readonly(ptr) {
      const sql = raw.UTF8ToString(raw._sqlite3_sql(ptr)).trim().replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/, "");
      if (/^PRAGMA\b/i.test(sql)) return /=/.test(sql) ? 0 : 1;
      return /^(SELECT|WITH|EXPLAIN)\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql) ? 1 : 0;
    },
    _sqlite3_column_int64(ptr, col) { return BigInt(raw.UTF8ToString(raw._sqlite3_column_text(ptr, col))); },
    _sqlite3_bind_int64(ptr, col, value) {
      if (typeof value !== "bigint") throw new Error("i64 ABI requires bigint");
      if (value >= -2147483648n && value <= 2147483647n) return raw._sqlite3_bind_int(ptr, col, Number(value));
      // SQLite INTEGER affinity preserves the decimal value; the production
      // integration test additionally asserts the actual i64 parameter type.
      const p = text(value.toString());
      try { return raw._sqlite3_bind_text(ptr, col, p, -1, -1); } finally { raw._free(p); }
    },
    _sqlite3_bind_null: (ptr, col) => raw._sqlite3_bind_blob(ptr, col, 0, 0, 0),
    _sqlite3_get_autocommit: (ptr) => transactions.has(ptr) ? 0 : 1,
    _sqlite3_serialize(db, _schema, out) {
      const bytes = owners.get(db)?.export(); if (!bytes) return 0;
      const p = mod._malloc(Math.max(1, bytes.length)); mod.HEAPU8.set(bytes, p);
      new DataView(memory.buffer).setBigInt64(out, BigInt(bytes.length), true); return p;
    },
    _spatialite_wasm_init: () => 1,
    _spatialite_wasm_cleanup() {},
    _spatialite_wasm_version: () => versionPtr,
    _spatialite_wasm_has_geos: () => 0,
    _spatialite_wasm_has_proj: () => 0,
  };
  return { mod, allocations, files, workerFsMounts, openFlags, close() { for (const db of owners.values()) db.close(); raw._free(versionPtr); } };
}
