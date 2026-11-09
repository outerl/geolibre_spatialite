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

/** The native build uses wasm32 pointers and -sWASM_BIGINT=1 for SQLite i64s. */
export interface SpatialiteWasmModule {
  HEAPU8: Uint8Array;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
  UTF8ToString(ptr: number): string;
  stackSave(): number;
  stackRestore(ptr: number): void;
  stackAlloc(size: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  _sqlite3_open(filename: number, ppDb: number): number;
  _sqlite3_close_v2(db: number): number;
  _sqlite3_prepare_v2(db: number, sql: number, bytes: number, ppStmt: number, tail: number): number;
  _sqlite3_step(stmt: number): number;
  _sqlite3_finalize(stmt: number): number;
  _sqlite3_reset(stmt: number): number;
  _sqlite3_clear_bindings(stmt: number): number;
  _sqlite3_bind_parameter_count(stmt: number): number;
  _sqlite3_column_count(stmt: number): number;
  _sqlite3_column_type(stmt: number, col: number): number;
  _sqlite3_column_name(stmt: number, col: number): number;
  _sqlite3_column_text(stmt: number, col: number): number;
  _sqlite3_column_blob(stmt: number, col: number): number;
  _sqlite3_column_bytes(stmt: number, col: number): number;
  _sqlite3_column_double(stmt: number, col: number): number;
  _sqlite3_column_int64(stmt: number, col: number): bigint;
  _sqlite3_bind_null(stmt: number, col: number): number;
  _sqlite3_bind_text(stmt: number, col: number, value: number, bytes: number, destructor: number): number;
  _sqlite3_bind_blob(stmt: number, col: number, value: number, bytes: number, destructor: number): number;
  _sqlite3_bind_double(stmt: number, col: number, value: number): number;
  _sqlite3_bind_int64(stmt: number, col: number, value: bigint): number;
  _sqlite3_get_autocommit(db: number): number;
  _sqlite3_serialize(db: number, schema: number, size: number, flags: number): number;
  _sqlite3_free(ptr: number): void;
  _sqlite3_errmsg(db: number): number;
  _spatialite_wasm_init(db: number): number;
  _spatialite_wasm_cleanup(cache: number): void;
  _spatialite_wasm_version(): number;
  _spatialite_wasm_has_geos(): number;
  _spatialite_wasm_has_proj(): number;
}

const SQLITE_OK = 0, SQLITE_ROW = 100, SQLITE_DONE = 101, SQLITE_TRANSIENT = -1;
const MIN_I64 = -(1n << 63n), MAX_I64 = (1n << 63n) - 1n;
const MIN_SAFE_I64 = BigInt(Number.MIN_SAFE_INTEGER), MAX_SAFE_I64 = BigInt(Number.MAX_SAFE_INTEGER);
const encoder = new TextEncoder(), decoder = new TextDecoder();
let dbIdCounter = 0;

function allocate(mod: SpatialiteWasmModule, bytes: number): number {
  const ptr = mod._malloc(Math.max(1, bytes));
  if (!ptr) throw new Error("WebAssembly memory allocation failed.");
  return ptr;
}
function allocateText(mod: SpatialiteWasmModule, text: string): { ptr: number; bytes: number } {
  const bytes = encoder.encode(text);
  const ptr = allocate(mod, bytes.length + 1);
  mod.HEAPU8.set(bytes, ptr);
  mod.HEAPU8[ptr + bytes.length] = 0;
  return { ptr, bytes: bytes.length };
}
function error(mod: SpatialiteWasmModule, db: number, rc: number): Error {
  return new Error(`${mod.UTF8ToString(mod._sqlite3_errmsg(db)) || "SQLite error"} (code ${rc})`);
}
function removeFiles(mod: SpatialiteWasmModule, path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { mod.FS.unlink(path + suffix); } catch { /* An absent sidecar is normal. */ }
  }
}
function hasSql(text: string): boolean {
  return text.replace(/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$)/g, "") !== "";
}

export class NativeCStatement implements IStatementBackend {
  private columnNamesCache: string[] | null = null;
  constructor(
    private readonly mod: SpatialiteWasmModule,
    private readonly dbPtr: number,
    private stmtPtr: number,
    private readonly onFree?: (stmt: NativeCStatement) => void,
  ) {}
  private assertOpen(): void { if (!this.stmtPtr) throw new Error("Statement is finalized."); }
  private check(rc: number): void { if (rc !== SQLITE_OK) throw error(this.mod, this.dbPtr, rc); }
  step(): boolean {
    this.assertOpen();
    const rc = this.mod._sqlite3_step(this.stmtPtr);
    if (rc === SQLITE_ROW) return true;
    if (rc === SQLITE_DONE) return false;
    throw error(this.mod, this.dbPtr, rc);
  }
  get(): SqlValue[] {
    this.assertOpen();
    const row: SqlValue[] = [];
    const count = this.mod._sqlite3_column_count(this.stmtPtr);
    for (let i = 0; i < count; i++) {
      switch (this.mod._sqlite3_column_type(this.stmtPtr, i)) {
        case 1: {
          const n = this.mod._sqlite3_column_int64(this.stmtPtr, i);
          row.push(n >= MIN_SAFE_I64 && n <= MAX_SAFE_I64 ? Number(n) : n);
          break;
        }
        case 2: row.push(this.mod._sqlite3_column_double(this.stmtPtr, i)); break;
        case 3: {
          const ptr = this.mod._sqlite3_column_text(this.stmtPtr, i);
          row.push(decoder.decode(this.mod.HEAPU8.subarray(ptr, ptr + this.mod._sqlite3_column_bytes(this.stmtPtr, i))));
          break;
        }
        case 4: {
          const ptr = this.mod._sqlite3_column_blob(this.stmtPtr, i);
          row.push(this.mod.HEAPU8.slice(ptr, ptr + this.mod._sqlite3_column_bytes(this.stmtPtr, i)));
          break;
        }
        default: row.push(null);
      }
    }
    return row;
  }
  getAsObject(): SqlRow {
    const values = this.get();
    return Object.fromEntries(this.getColumnNames().map((name, i) => [name, values[i] ?? null]));
  }
  getColumnNames(): string[] {
    this.assertOpen();
    this.columnNamesCache ??= Array.from({ length: this.mod._sqlite3_column_count(this.stmtPtr) }, (_, i) =>
      this.mod.UTF8ToString(this.mod._sqlite3_column_name(this.stmtPtr, i)));
    return [...this.columnNamesCache];
  }
  bind(params: SqlValue[] = []): boolean {
    this.reset();
    if (params.length > this.mod._sqlite3_bind_parameter_count(this.stmtPtr)) throw new Error("Too many SQL parameters.");
    for (let i = 0; i < params.length; i++) {
      const col = i + 1, value = params[i];
      let rc: number;
      if (value === null || value === undefined) rc = this.mod._sqlite3_bind_null(this.stmtPtr, col);
      else if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
        if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Use bigint for integers outside JavaScript's safe range.");
        const integer = BigInt(value);
        if (integer < MIN_I64 || integer > MAX_I64) throw new Error("SQL integer is outside the signed 64-bit range.");
        rc = this.mod._sqlite3_bind_int64(this.stmtPtr, col, integer);
      } else if (typeof value === "number") rc = this.mod._sqlite3_bind_double(this.stmtPtr, col, value);
      else if (typeof value === "string") {
        const text = allocateText(this.mod, value);
        try { rc = this.mod._sqlite3_bind_text(this.stmtPtr, col, text.ptr, text.bytes, SQLITE_TRANSIENT); }
        finally { this.mod._free(text.ptr); }
      } else {
        const ptr = allocate(this.mod, value.length);
        try {
          this.mod.HEAPU8.set(value, ptr);
          rc = this.mod._sqlite3_bind_blob(this.stmtPtr, col, ptr, value.length, SQLITE_TRANSIENT);
        } finally { this.mod._free(ptr); }
      }
      this.check(rc);
    }
    return true;
  }
  reset(): void {
    this.assertOpen();
    const rc = this.mod._sqlite3_reset(this.stmtPtr);
    this.check(this.mod._sqlite3_clear_bindings(this.stmtPtr));
    this.check(rc);
  }
  free(): void {
    if (this.stmtPtr) {
      this.mod._sqlite3_finalize(this.stmtPtr);
      this.stmtPtr = 0;
      this.onFree?.(this);
    }
  }
}

export class NativeCDatabase implements IDatabaseBackend {
  readonly isNativeC = true;
  private closed = false;
  private readonly statements = new Set<NativeCStatement>();
  private readonly sqlAllocations = new Set<number>();
  constructor(
    private readonly mod: SpatialiteWasmModule,
    private dbPtr: number,
    private cachePtr: number,
    private readonly filePath: string,
  ) {}
  static open(mod: SpatialiteWasmModule, data?: Uint8Array | ArrayBuffer): NativeCDatabase {
    const path = `/spatialite_${++dbIdCounter}.sqlite`;
    let dbPtr = 0, cachePtr = 0;
    const text = allocateText(mod, path);
    const stack = mod.stackSave();
    try {
      if (data) mod.FS.writeFile(path, data instanceof Uint8Array ? data : new Uint8Array(data));
      const out = mod.stackAlloc(4); mod.setValue(out, 0, "*");
      const rc = mod._sqlite3_open(text.ptr, out);
      dbPtr = mod.getValue(out, "*");
      if (rc !== SQLITE_OK) throw error(mod, dbPtr, rc);
      cachePtr = mod._spatialite_wasm_init(dbPtr);
      if (!cachePtr) throw new Error("SpatiaLite connection initialization failed.");
      const db = new NativeCDatabase(mod, dbPtr, cachePtr, path);
      db.exec("PRAGMA schema_version");
      return db;
    } catch (cause) {
      if (dbPtr) mod._sqlite3_close_v2(dbPtr);
      if (cachePtr) mod._spatialite_wasm_cleanup(cachePtr);
      removeFiles(mod, path);
      throw cause;
    } finally { mod._free(text.ptr); mod.stackRestore(stack); }
  }
  private assertOpen(): void { if (this.closed) throw new Error("Database is closed."); }
  private track(ptr: number): NativeCStatement {
    const stmt = new NativeCStatement(this.mod, this.dbPtr, ptr, (value) => { this.statements.delete(value); });
    this.statements.add(stmt);
    return stmt;
  }
  private preparePointer(sql: number): { stmt: number; tail: number } {
    this.assertOpen();
    const stack = this.mod.stackSave();
    try {
      const out = this.mod.stackAlloc(4), tail = this.mod.stackAlloc(4);
      this.mod.setValue(out, 0, "*"); this.mod.setValue(tail, 0, "*");
      const rc = this.mod._sqlite3_prepare_v2(this.dbPtr, sql, -1, out, tail);
      const ptr = this.mod.getValue(out, "*");
      if (rc !== SQLITE_OK) {
        if (ptr) this.mod._sqlite3_finalize(ptr);
        throw error(this.mod, this.dbPtr, rc);
      }
      return { stmt: ptr, tail: this.mod.getValue(tail, "*") };
    } finally { this.mod.stackRestore(stack); }
  }
  prepare(sql: string): IStatementBackend {
    this.assertOpen();
    const text = allocateText(this.mod, sql);
    let stmt: NativeCStatement | undefined;
    try {
      const result = this.preparePointer(text.ptr);
      if (!result.stmt) throw new Error("SQL statement is empty.");
      stmt = this.track(result.stmt);
      if (result.tail && hasSql(this.mod.UTF8ToString(result.tail))) throw new Error("Bound queries must contain a single SQL statement.");
      return stmt;
    } catch (cause) { stmt?.free(); throw cause; }
    finally { this.mod._free(text.ptr); }
  }
  *iterateStatements(sql: string): IterableIterator<IStatementBackend> {
    this.assertOpen();
    const text = allocateText(this.mod, sql);
    this.sqlAllocations.add(text.ptr);
    let cursor = text.ptr;
    try {
      while (this.mod.HEAPU8[cursor]) {
        const result = this.preparePointer(cursor);
        if (result.stmt) {
          const stmt = this.track(result.stmt);
          try { yield stmt; } finally { stmt.free(); }
        }
        if (!result.tail || result.tail <= cursor) break;
        cursor = result.tail;
      }
    } finally { if (this.sqlAllocations.delete(text.ptr)) this.mod._free(text.ptr); }
  }
  run(sql: string, params?: SqlValue[]): void {
    this.assertOpen();
    if (params?.length) {
      const stmt = this.prepare(sql);
      try { stmt.bind(params); while (stmt.step()) { /* Discard RETURNING rows. */ } }
      finally { stmt.free(); }
    } else for (const stmt of this.iterateStatements(sql)) while (stmt.step()) { /* Execute all statements. */ }
  }
  exec(sql: string, params?: SqlValue[]): { columns: string[]; values: SqlValue[][] }[] {
    this.assertOpen();
    const results: { columns: string[]; values: SqlValue[][] }[] = [];
    const collect = (stmt: IStatementBackend): void => {
      const columns = stmt.getColumnNames(), values: SqlValue[][] = [];
      while (stmt.step()) values.push(stmt.get());
      if (columns.length) results.push({ columns, values });
    };
    if (params?.length) {
      const stmt = this.prepare(sql);
      try { stmt.bind(params); collect(stmt); } finally { stmt.free(); }
    } else for (const stmt of this.iterateStatements(sql)) collect(stmt);
    return results;
  }
  export(): Uint8Array {
    this.assertOpen();
    if (!this.mod._sqlite3_get_autocommit(this.dbPtr) || this.statements.size) throw new Error("Finish transactions and active statements before exporting.");
    const schema = allocateText(this.mod, "main");
    let ptr = 0, size = 0;
    try {
      size = allocate(this.mod, 8);
      this.mod.HEAPU8.fill(0, size, size + 8);
      // SQLite serialization reads through the pager, including committed WAL pages.
      ptr = this.mod._sqlite3_serialize(this.dbPtr, schema.ptr, size, 0);
      const bytes = new DataView(this.mod.HEAPU8.buffer).getBigInt64(size, true);
      if (!ptr && bytes === 0n) return new Uint8Array(); // SQLite's valid empty-file image.
      if (!ptr) throw new Error("SQLite could not serialize the database.");
      if (bytes < 0n || bytes > BigInt(this.mod.HEAPU8.length - ptr)) throw new Error("Invalid serialized database size.");
      const snapshot = this.mod.HEAPU8.slice(ptr, ptr + Number(bytes));
      // A standalone snapshot has no WAL sidecar. Keep it portable to readers
      // (including sqlite3_deserialize) that cannot open WAL-format images.
      if (snapshot.length >= 100) { snapshot[18] = 1; snapshot[19] = 1; }
      return snapshot;
    } finally {
      if (ptr) this.mod._sqlite3_free(ptr);
      if (size) this.mod._free(size);
      this.mod._free(schema.ptr);
    }
  }
  getSpatialiteVersion(): string { this.assertOpen(); return this.mod.UTF8ToString(this.mod._spatialite_wasm_version()); }
  hasGeos(): boolean { this.assertOpen(); return this.mod._spatialite_wasm_has_geos() === 1; }
  hasProj(): boolean { this.assertOpen(); return this.mod._spatialite_wasm_has_proj() === 1; }
  close(): void {
    if (this.closed) return;
    for (const stmt of this.statements) stmt.free();
    const rc = this.mod._sqlite3_close_v2(this.dbPtr);
    if (rc !== SQLITE_OK) throw error(this.mod, this.dbPtr, rc);
    this.dbPtr = 0;
    this.mod._spatialite_wasm_cleanup(this.cachePtr); this.cachePtr = 0;
    for (const ptr of this.sqlAllocations) this.mod._free(ptr);
    this.sqlAllocations.clear();
    this.closed = true;
    removeFiles(this.mod, this.filePath);
  }
}
