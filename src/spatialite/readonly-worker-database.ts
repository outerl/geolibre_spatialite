// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { NativeCStatement, type SpatialiteWasmModule, type SqlRow, type SqlValue } from "./c-wasm-adapter.js";

const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_OPEN_READONLY = 0x00000001;
const MOUNT_POINT = "/paged-file";
const FILE_PATH = `${MOUNT_POINT}/database.sqlite`;

export interface PagedFileStats {
  fileSize: number;
  sliceBytesRequested: number;
  sliceRequestCount: number;
  cacheBytes: number;
  nativeFactoryMs: number;
  sqliteMountOpenMs: number;
  openElapsedMs: number;
}

export interface PagedCursorBatch {
  columns: string[];
  rows: SqlRow[];
  bytes: number;
  done: boolean;
}

function allocatedText(mod: SpatialiteWasmModule, value: string): { ptr: number; byteLength: number } {
  const bytes = new TextEncoder().encode(value);
  const ptr = mod._malloc(bytes.length + 1);
  if (!ptr) throw new Error("WebAssembly memory allocation failed.");
  mod.HEAPU8.set(bytes, ptr);
  mod.HEAPU8[ptr + bytes.length] = 0;
  return { ptr, byteLength: bytes.length };
}

function sqliteError(mod: SpatialiteWasmModule, dbPtr: number, rc: number): Error {
  const messagePtr = dbPtr ? mod._sqlite3_errmsg(dbPtr) : 0;
  const message = messagePtr ? mod.UTF8ToString(messagePtr) : "SQLite error";
  const recovery = rc === 264 || rc === 776
    ? " The file needs rollback-journal recovery, which a read-only Blob connection cannot perform."
    : "";
  return new Error(`${message} (SQLite code ${rc}).${recovery}`);
}

function validateHeader(blob: Blob): void {
  if (blob.size < 100) throw new Error("The selected file is too small to be a SQLite database.");
}

/** Read-only native connection backed by Emscripten WORKERFS; it never imports file bytes into MEMFS. */
export class NativeCReadOnlyDatabase {
  private readonly cursors = new Map<number, NativeCStatement>();
  private readonly positioned = new Set<number>();
  private nextCursorId = 1;
  private closed = false;

  private constructor(
    private readonly mod: SpatialiteWasmModule,
    private dbPtr: number,
    private cachePtr: number,
    readonly stats: PagedFileStats,
  ) {}

  static async open(mod: SpatialiteWasmModule, blob: Blob, cacheMiB: number, readStats?: PagedFileStats): Promise<NativeCReadOnlyDatabase> {
    validateHeader(blob);
    const header = new Uint8Array(await blob.slice(0, 100).arrayBuffer());
    const signature = new TextDecoder().decode(header.subarray(0, 16));
    if (signature !== "SQLite format 3\0") throw new Error("The selected file is not a SQLite database.");
    if (header[18] === 2 || header[19] === 2) {
      throw new Error("This file uses WAL mode. Checkpoint it and provide one consistent standalone database file.");
    }
    if (header[18] !== 1 || header[19] !== 1) {
      throw new Error("The file has an unsupported SQLite journal format; provide a consistent rollback-journal snapshot.");
    }
    if (!mod.WORKERFS || !mod.FS.mount || !mod.FS.unmount || !mod._sqlite3_open_v2 || !mod._sqlite3_stmt_readonly) {
      throw new Error("This native artifact does not support paged reads (WORKERFS and SQLite read-only exports are required). Rebuild or download a current artifact.");
    }

    let mounted = false;
    let dbPtr = 0;
    let cachePtr = 0;
    try {
      mod.FS.mkdirTree(MOUNT_POINT);
      mod.FS.mount(mod.WORKERFS, { blobs: [{ name: "database.sqlite", data: blob }] }, MOUNT_POINT);
      mounted = true;
      const filename = allocatedText(mod, FILE_PATH);
      const stack = mod.stackSave();
      try {
        const output = mod.stackAlloc(4);
        mod.setValue(output, 0, "*");
        const rc = mod._sqlite3_open_v2(filename.ptr, output, SQLITE_OPEN_READONLY, 0);
        dbPtr = mod.getValue(output, "*");
        if (rc !== SQLITE_OK) throw sqliteError(mod, dbPtr, rc);
      } finally {
        mod.stackRestore(stack);
        mod._free(filename.ptr);
      }
      cachePtr = mod._spatialite_wasm_init(dbPtr);
      if (!cachePtr) throw new Error("SpatiaLite read-only connection initialization failed.");
      const stats: PagedFileStats = readStats ?? {
        fileSize: blob.size, sliceBytesRequested: 100, sliceRequestCount: 1,
        cacheBytes: cacheMiB * 1024 * 1024, nativeFactoryMs: 0, sqliteMountOpenMs: 0, openElapsedMs: 0,
      };
      stats.cacheBytes = cacheMiB * 1024 * 1024;
      const connection = new NativeCReadOnlyDatabase(mod, dbPtr, cachePtr, stats);
      connection.execPragma(`PRAGMA cache_size = -${cacheMiB * 1024}`);
      connection.execPragma("PRAGMA mmap_size = 0");
      connection.execPragma("PRAGMA query_only = ON");
      return connection;
    } catch (cause) {
      if (dbPtr) mod._sqlite3_close_v2(dbPtr);
      if (cachePtr) mod._spatialite_wasm_cleanup(cachePtr);
      if (mounted) mod.FS.unmount(MOUNT_POINT);
      throw cause;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Paged database is closed.");
  }

  private execPragma(sql: string): void {
    this.assertOpen();
    const filename = allocatedText(this.mod, sql);
    const stack = this.mod.stackSave();
    let stmtPtr = 0;
    try {
      const output = this.mod.stackAlloc(4);
      this.mod.setValue(output, 0, "*");
      const rc = this.mod._sqlite3_prepare_v2(this.dbPtr, filename.ptr, -1, output, 0);
      stmtPtr = this.mod.getValue(output, "*");
      if (rc !== SQLITE_OK) throw sqliteError(this.mod, this.dbPtr, rc);
      if (!stmtPtr) throw new Error("SQLite pragma is empty.");
      let step = this.mod._sqlite3_step(stmtPtr);
      while (step === SQLITE_ROW) step = this.mod._sqlite3_step(stmtPtr);
      if (step !== SQLITE_DONE) throw sqliteError(this.mod, this.dbPtr, step);
    } finally {
      if (stmtPtr) this.mod._sqlite3_finalize(stmtPtr);
      this.mod.stackRestore(stack);
      this.mod._free(filename.ptr);
    }
  }

  private prepare(sql: string, params: SqlValue[]): NativeCStatement {
    this.assertOpen();
    if (!sql.trim()) throw new Error("SQL statement is empty.");
    const text = allocatedText(this.mod, sql);
    const stack = this.mod.stackSave();
    let stmtPtr = 0;
    let statement: NativeCStatement | null = null;
    try {
      const output = this.mod.stackAlloc(4);
      const tail = this.mod.stackAlloc(4);
      this.mod.setValue(output, 0, "*");
      this.mod.setValue(tail, 0, "*");
      const rc = this.mod._sqlite3_prepare_v2(this.dbPtr, text.ptr, -1, output, tail);
      stmtPtr = this.mod.getValue(output, "*");
      if (rc !== SQLITE_OK) throw sqliteError(this.mod, this.dbPtr, rc);
      if (!stmtPtr) throw new Error("SQL statement is empty.");
      const tailPtr = this.mod.getValue(tail, "*");
      if (tailPtr && this.mod.UTF8ToString(tailPtr).trim()) throw new Error("Paged queries must contain one SQL statement.");
      if (this.mod._sqlite3_stmt_readonly?.(stmtPtr) !== 1) {
        throw new Error("Paged connections only allow read-only SQL statements.");
      }
      statement = new NativeCStatement(this.mod, this.dbPtr, stmtPtr);
      stmtPtr = 0;
      if (params.length !== statement.getBindParameterCount()) {
        statement.free();
        statement = null;
        throw new Error("The SQL parameter count does not match the bound values.");
      }
      if (params.length) statement.bind(params);
      const prepared = statement;
      statement = null;
      return prepared;
    } catch (cause) {
      statement?.free();
      if (stmtPtr) this.mod._sqlite3_finalize(stmtPtr);
      throw cause;
    } finally {
      this.mod.stackRestore(stack);
      this.mod._free(text.ptr);
    }
  }

  startQuery(sql: string, params: SqlValue[] = []): { cursorId: number; columns: string[] } {
    const statement = this.prepare(sql, params);
    const cursorId = this.nextCursorId++;
    this.cursors.set(cursorId, statement);
    return { cursorId, columns: statement.getColumnNames() };
  }

  readBatch(cursorId: number, batchSize: number, maxBytes = 4 * 1024 * 1024): PagedCursorBatch {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error("Invalid batch size.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error("Invalid batch byte limit.");
    const statement = this.cursors.get(cursorId);
    if (!statement) throw new Error("Paged query cursor is closed.");
    const columns = statement.getColumnNames();
    const rows: SqlRow[] = [];
    let bytes = 0;
    let done = false;
    try {
      while (rows.length < batchSize) {
        if (!this.positioned.delete(cursorId) && !statement.step()) { done = true; break; }
        const rowBytes = statement.getOutputByteLength();
        if (rowBytes > 16 * 1024 * 1024) throw new Error("A query row exceeds the 16 MiB row limit.");
        if (rowBytes > maxBytes - bytes) {
          if (rows.length === 0) throw new Error("A query row exceeds the requested batch byte limit.");
          this.positioned.add(cursorId);
          break;
        }
        const values = statement.get();
        const row: SqlRow = {};
        columns.forEach((column, index) => {
          Object.defineProperty(row, column, { value: values[index] ?? null, enumerable: true, configurable: true });
        });
        rows.push(row);
        bytes += rowBytes;
      }
      if (done) this.closeCursor(cursorId);
      return { columns, rows, bytes, done };
    } catch (cause) {
      this.closeCursor(cursorId);
      throw cause;
    }
  }

  hasMore(cursorId: number): boolean {
    const statement = this.cursors.get(cursorId);
    if (!statement) return false;
    if (this.positioned.has(cursorId)) return true;
    if (statement.step()) { this.positioned.add(cursorId); return true; }
    this.closeCursor(cursorId);
    return false;
  }

  closeCursor(cursorId: number): void {
    const statement = this.cursors.get(cursorId);
    if (statement) {
      this.cursors.delete(cursorId);
      this.positioned.delete(cursorId);
      statement.free();
    }
  }

  close(): void {
    if (this.closed) return;
    for (const cursorId of this.cursors.keys()) this.closeCursor(cursorId);
    const rc = this.mod._sqlite3_close_v2(this.dbPtr);
    if (rc !== SQLITE_OK) throw sqliteError(this.mod, this.dbPtr, rc);
    this.dbPtr = 0;
    this.mod._spatialite_wasm_cleanup(this.cachePtr);
    this.cachePtr = 0;
    this.mod.FS.unmount?.(MOUNT_POINT);
    this.closed = true;
  }
}
