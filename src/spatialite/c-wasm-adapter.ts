// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

export type SqlValue = number | string | Uint8Array | null | bigint;
export type SqlRow = Record<string, SqlValue>;

export interface IStatementBackend {
  step(): boolean;
  get(): SqlValue[];
  getAsObject(): SqlRow;
  getColumnNames(): string[];
  free(): void;
  reset(): void;
  bind(params?: SqlValue[]): boolean;
}

export interface IDatabaseBackend {
  readonly isNativeC: boolean;
  run(sql: string, params?: SqlValue[]): void;
  exec(sql: string, params?: SqlValue[]): { columns: string[]; values: SqlValue[][] }[];
  prepare(sql: string): IStatementBackend;
  iterateStatements(sql: string): IterableIterator<IStatementBackend>;
  export(): Uint8Array;
  close(): void;
  getSpatialiteVersion?(): string;
  hasGeos?(): boolean;
  hasProj?(): boolean;
}

/**
 * Minimal Emscripten C runtime interface for SQLite + SpatiaLite.
 */
export interface SpatialiteWasmModule {
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
  UTF8ToString(ptr: number): string;
  allocateUTF8(str: string): number;
  stackSave(): number;
  stackRestore(ptr: number): void;
  stackAlloc(size: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  _sqlite3_open(filename: number, ppDb: number): number;
  _sqlite3_close_v2(db: number): number;
  _sqlite3_exec(db: number, sql: number, callback: number, arg: number, errmsg: number): number;
  _sqlite3_prepare_v2(db: number, zSql: number, nByte: number, ppStmt: number, pzTail: number): number;
  _sqlite3_step(stmt: number): number;
  _sqlite3_finalize(stmt: number): number;
  _sqlite3_reset(stmt: number): number;
  _sqlite3_column_count(stmt: number): number;
  _sqlite3_column_type(stmt: number, iCol: number): number;
  _sqlite3_column_name(stmt: number, iCol: number): number;
  _sqlite3_column_text(stmt: number, iCol: number): number;
  _sqlite3_column_blob(stmt: number, iCol: number): number;
  _sqlite3_column_bytes(stmt: number, iCol: number): number;
  _sqlite3_column_double(stmt: number, iCol: number): number;
  _sqlite3_column_int64(stmt: number, iCol: number): number;
  _sqlite3_bind_null(stmt: number, iCol: number): number;
  _sqlite3_bind_text(stmt: number, iCol: number, val: number, len: number, dtor: number): number;
  _sqlite3_bind_blob(stmt: number, iCol: number, val: number, len: number, dtor: number): number;
  _sqlite3_bind_double(stmt: number, iCol: number, val: number): number;
  _sqlite3_bind_int64(stmt: number, iCol: number, val: number): number;
  _sqlite3_errmsg(db: number): number;
  _sqlite3_changes(db: number): number;
  _spatialite_wasm_init(db: number): number;
  _spatialite_wasm_cleanup(cache: number): void;
  _spatialite_wasm_version(): number;
  _spatialite_wasm_target_cpu(): number;
  _spatialite_wasm_has_geos(): number;
  _spatialite_wasm_has_proj(): number;
}

// SQLite 3 constants
const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;
const SQLITE_TRANSIENT = -1;

let dbIdCounter = 0;

export class NativeCStatement implements IStatementBackend {
  private stmtPtr: number;
  private mod: SpatialiteWasmModule;
  private dbPtr: number;
  private columnNamesCache: string[] | null = null;

  constructor(mod: SpatialiteWasmModule, dbPtr: number, stmtPtr: number) {
    this.mod = mod;
    this.dbPtr = dbPtr;
    this.stmtPtr = stmtPtr;
  }

  step(): boolean {
    if (!this.stmtPtr) throw new Error("Statement is finalized.");
    const rc = this.mod._sqlite3_step(this.stmtPtr);
    if (rc === SQLITE_ROW) return true;
    if (rc === SQLITE_DONE) return false;
    throw new Error(`SQLite step error: ${this.mod.UTF8ToString(this.mod._sqlite3_errmsg(this.dbPtr))}`);
  }

  get(): SqlValue[] {
    if (!this.stmtPtr) throw new Error("Statement is finalized.");
    const count = this.mod._sqlite3_column_count(this.stmtPtr);
    const row: SqlValue[] = [];
    for (let index = 0; index < count; index += 1) {
      const type = this.mod._sqlite3_column_type(this.stmtPtr, index);
      if (type === SQLITE_NULL) {
        row.push(null);
      } else if (type === SQLITE_INTEGER || type === SQLITE_FLOAT) {
        row.push(this.mod._sqlite3_column_double(this.stmtPtr, index));
      } else if (type === SQLITE_TEXT) {
        row.push(this.mod.UTF8ToString(this.mod._sqlite3_column_text(this.stmtPtr, index)));
      } else if (type === SQLITE_BLOB) {
        const bytes = this.mod._sqlite3_column_bytes(this.stmtPtr, index);
        const blobPtr = this.mod._sqlite3_column_blob(this.stmtPtr, index);
        if (blobPtr && bytes > 0) {
          const heap = new Uint8Array((this.mod as unknown as { HEAPU8: Uint8Array }).HEAPU8.buffer, blobPtr, bytes);
          row.push(new Uint8Array(heap));
        } else {
          row.push(new Uint8Array(0));
        }
      } else {
        row.push(null);
      }
    }
    return row;
  }

  getAsObject(): SqlRow {
    const names = this.getColumnNames();
    const values = this.get();
    const result: SqlRow = {};
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (name !== undefined) {
        result[name] = values[index] ?? null;
      }
    }
    return result;
  }

  getColumnNames(): string[] {
    if (this.columnNamesCache) return this.columnNamesCache;
    const count = this.mod._sqlite3_column_count(this.stmtPtr);
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const namePtr = this.mod._sqlite3_column_name(this.stmtPtr, index);
      names.push(this.mod.UTF8ToString(namePtr));
    }
    this.columnNamesCache = names;
    return names;
  }

  bind(params?: SqlValue[]): boolean {
    if (!this.stmtPtr) throw new Error("Statement is finalized.");
    this.mod._sqlite3_reset(this.stmtPtr);
    if (!params || params.length === 0) return true;
    for (let index = 0; index < params.length; index += 1) {
      const colIndex = index + 1; // 1-based indexing in SQLite
      const value = params[index];
      if (value === null || value === undefined) {
        this.mod._sqlite3_bind_null(this.stmtPtr, colIndex);
      } else if (typeof value === "number") {
        this.mod._sqlite3_bind_double(this.stmtPtr, colIndex, value);
      } else if (typeof value === "bigint") {
        this.mod._sqlite3_bind_int64(this.stmtPtr, colIndex, Number(value));
      } else if (typeof value === "string") {
        const strPtr = this.mod.allocateUTF8(value);
        this.mod._sqlite3_bind_text(this.stmtPtr, colIndex, strPtr, -1, SQLITE_TRANSIENT);
        this.mod._free(strPtr);
      } else if (value instanceof Uint8Array) {
        const memPtr = this.mod._malloc(value.length);
        const heap = new Uint8Array((this.mod as unknown as { HEAPU8: Uint8Array }).HEAPU8.buffer);
        heap.set(value, memPtr);
        this.mod._sqlite3_bind_blob(this.stmtPtr, colIndex, memPtr, value.length, SQLITE_TRANSIENT);
        this.mod._free(memPtr);
      }
    }
    return true;
  }

  reset(): void {
    if (this.stmtPtr) this.mod._sqlite3_reset(this.stmtPtr);
  }

  free(): void {
    if (this.stmtPtr) {
      this.mod._sqlite3_finalize(this.stmtPtr);
      this.stmtPtr = 0;
    }
  }
}

export class NativeCDatabase implements IDatabaseBackend {
  readonly isNativeC = true;
  private mod: SpatialiteWasmModule;
  private dbPtr: number;
  private cachePtr: number;
  private filePath: string;
  private closed = false;

  constructor(mod: SpatialiteWasmModule, dbPtr: number, cachePtr: number, filePath: string) {
    this.mod = mod;
    this.dbPtr = dbPtr;
    this.cachePtr = cachePtr;
    this.filePath = filePath;
  }

  static open(mod: SpatialiteWasmModule, data?: Uint8Array | ArrayBuffer): NativeCDatabase {
    dbIdCounter += 1;
    const filePath = `/spatialite_${Date.now()}_${dbIdCounter}.sqlite`;
    if (data) {
      mod.FS.writeFile(filePath, data instanceof Uint8Array ? data : new Uint8Array(data));
    }
    const stack = mod.stackSave();
    const ppDb = mod.stackAlloc(4);
    const pathPtr = mod.allocateUTF8(filePath);
    try {
      const rc = mod._sqlite3_open(pathPtr, ppDb);
      if (rc !== SQLITE_OK) {
        throw new Error(`Failed to open SQLite database: error code ${rc}`);
      }
      const dbPtr = mod.getValue(ppDb, "*");
      const cachePtr = mod._spatialite_wasm_init(dbPtr);
      return new NativeCDatabase(mod, dbPtr, cachePtr, filePath);
    } finally {
      mod._free(pathPtr);
      mod.stackRestore(stack);
    }
  }

  private assertOpen(): void {
    if (this.closed || !this.dbPtr) throw new Error("Database is closed.");
  }

  run(sql: string, params?: SqlValue[]): void {
    this.assertOpen();
    const stmt = this.prepare(sql);
    try {
      if (params && params.length > 0) stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
  }

  exec(sql: string): { columns: string[]; values: SqlValue[][] }[] {
    this.assertOpen();
    const results: { columns: string[]; values: SqlValue[][] }[] = [];
    for (const stmt of this.iterateStatements(sql)) {
      try {
        const columns = stmt.getColumnNames();
        const values: SqlValue[][] = [];
        while (stmt.step()) {
          values.push(stmt.get());
        }
        results.push({ columns, values });
      } finally {
        stmt.free();
      }
    }
    return results;
  }

  prepare(sql: string): IStatementBackend {
    this.assertOpen();
    const stack = this.mod.stackSave();
    const ppStmt = this.mod.stackAlloc(4);
    const sqlPtr = this.mod.allocateUTF8(sql);
    try {
      const rc = this.mod._sqlite3_prepare_v2(this.dbPtr, sqlPtr, -1, ppStmt, 0);
      if (rc !== SQLITE_OK) {
        const errMsg = this.mod.UTF8ToString(this.mod._sqlite3_errmsg(this.dbPtr));
        throw new Error(errMsg || `SQLite prepare error (code ${rc})`);
      }
      const stmtPtr = this.mod.getValue(ppStmt, "*");
      return new NativeCStatement(this.mod, this.dbPtr, stmtPtr);
    } finally {
      this.mod._free(sqlPtr);
      this.mod.stackRestore(stack);
    }
  }

  *iterateStatements(sql: string): IterableIterator<IStatementBackend> {
    this.assertOpen();
    const stack = this.mod.stackSave();
    const ppStmt = this.mod.stackAlloc(4);
    const pzTail = this.mod.stackAlloc(4);
    let curSqlPtr = this.mod.allocateUTF8(sql);
    try {
      for (;;) {
        const rc = this.mod._sqlite3_prepare_v2(this.dbPtr, curSqlPtr, -1, ppStmt, pzTail);
        if (rc !== SQLITE_OK) {
          const errMsg = this.mod.UTF8ToString(this.mod._sqlite3_errmsg(this.dbPtr));
          throw new Error(errMsg || `SQLite prepare error (code ${rc})`);
        }
        const stmtPtr = this.mod.getValue(ppStmt, "*");
        const nextSqlPtr = this.mod.getValue(pzTail, "*");
        if (stmtPtr) {
          yield new NativeCStatement(this.mod, this.dbPtr, stmtPtr);
        }
        if (!nextSqlPtr || this.mod.UTF8ToString(nextSqlPtr).trim() === "") break;
        curSqlPtr = nextSqlPtr;
      }
    } finally {
      this.mod.stackRestore(stack);
    }
  }

  export(): Uint8Array {
    this.assertOpen();
    return this.mod.FS.readFile(this.filePath);
  }

  getSpatialiteVersion(): string {
    this.assertOpen();
    const ptr = this.mod._spatialite_wasm_version();
    return ptr ? this.mod.UTF8ToString(ptr) : "unknown";
  }

  hasGeos(): boolean {
    this.assertOpen();
    return this.mod._spatialite_wasm_has_geos() === 1;
  }

  hasProj(): boolean {
    this.assertOpen();
    return this.mod._spatialite_wasm_has_proj() === 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.cachePtr) {
      this.mod._spatialite_wasm_cleanup(this.cachePtr);
      this.cachePtr = 0;
    }
    if (this.dbPtr) {
      this.mod._sqlite3_close_v2(this.dbPtr);
      this.dbPtr = 0;
    }
    try {
      this.mod.FS.unlink(this.filePath);
    } catch {
      // ignored if already unlinked
    }
  }
}
