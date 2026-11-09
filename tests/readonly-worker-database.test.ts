// SPDX-License-Identifier: LGPL-2.1-or-later
// Tests SQLite/cursor behavior using the real SQLite WASM C API plus a test-only
// WORKERFS/open_v2 shim. This does not verify native Emscripten filesystem ABI.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadSqliteWasm } from "../src/spatialite/sqlite-engine.js";
import { NativeCReadOnlyDatabase } from "../src/spatialite/readonly-worker-database.js";
import { createRealSqliteModule } from "./helpers/real-sqlite-wasm.js";

class TestDatabaseBlob extends Blob {
  readonly nativeTestBytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    super([copy]);
    this.nativeTestBytes = new Uint8Array(copy);
  }
}

let bridge: Awaited<ReturnType<typeof createRealSqliteModule>>;
let bytes: Uint8Array;

beforeAll(async () => {
  bridge = await createRealSqliteModule();
  const SQL = await loadSqliteWasm();
  const source = new SQL.Database();
  source.run("CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT)");
  source.run("INSERT INTO records VALUES(1,'aaa'),(2,'bbb'),(3,'ccc')");
  source.run("CREATE TABLE wide(id INTEGER PRIMARY KEY, payload TEXT)");
  source.run(`INSERT INTO wide VALUES(1, '${"x".repeat(64)}')`);
  bytes = source.export();
  source.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(bridge.allocations.size).toBe(0);
  expect(bridge.files.size).toBe(0);
  expect(bridge.workerFsMounts.size).toBe(0);
});

afterAll(() => { bridge.close(); });

describe("WORKERFS read-only database adapter (SQLite test bridge)", () => {
  it("mounts the original Blob, reads actual SQLite rows in byte-bounded pulls, and unmounts on close", async () => {
    const connection = await NativeCReadOnlyDatabase.open(bridge.mod, new TestDatabaseBlob(bytes), 1);
    try {
      expect(bridge.openFlags).toEqual([1]);
      expect(bridge.files.size).toBe(0); // no MEMFS writeFile import
      expect(bridge.workerFsMounts.size).toBe(1);
      expect(connection.stats.cacheBytes).toBe(1024 * 1024);

      const cursor = connection.startQuery("SELECT id, label FROM records ORDER BY id");
      const first = connection.readBatch(cursor.cursorId, 3, 11);
      expect(first.rows).toEqual([{ id: 1, label: "aaa" }]);
      expect(first.bytes).toBe(11);
      expect(first.done).toBe(false);
      const second = connection.readBatch(cursor.cursorId, 3, 11);
      expect(second.rows).toEqual([{ id: 2, label: "bbb" }]);
      const third = connection.readBatch(cursor.cursorId, 3, 11);
      expect(third.rows).toEqual([{ id: 3, label: "ccc" }]);
      expect(third.done).toBe(true);
    } finally { connection.close(); }
    expect(bridge.workerFsMounts.size).toBe(0);
    expect(bridge.files.size).toBe(0);
  });

  it("rejects writes, mismatched bindings, multiple statements, and oversized rows while finalizing statements", async () => {
    const connection = await NativeCReadOnlyDatabase.open(bridge.mod, new TestDatabaseBlob(bytes), 2);
    try {
      expect(() => connection.startQuery("DELETE FROM records")).toThrow("read-only");
      expect(() => connection.startQuery("SELECT ?", [])).toThrow("parameter count");
      expect(() => connection.startQuery("SELECT 1; SELECT 2")).toThrow("one SQL statement");
      expect(() => connection.startQuery("SELECT ?", [9223372036854775808n])).toThrow("64-bit");

      const oversized = connection.startQuery("SELECT payload FROM wide");
      expect(() => connection.readBatch(oversized.cursorId, 1, 8)).toThrow("requested batch byte limit");
      const next = connection.startQuery("SELECT id FROM records ORDER BY id");
      expect(connection.readBatch(next.cursorId, 1, 32).rows).toEqual([{ id: 1 }]);
    } finally { connection.close(); }
  });

  it("rejects WAL headers and failed native opens while cleaning the mount", async () => {
    const wal = bytes.slice();
    wal[18] = 2;
    await expect(NativeCReadOnlyDatabase.open(bridge.mod, new TestDatabaseBlob(wal), 1)).rejects.toThrow("WAL mode");
    expect(bridge.workerFsMounts.size).toBe(0);

    // Too small
    await expect(NativeCReadOnlyDatabase.open(bridge.mod, new Blob(["short"]), 1)).rejects.toThrow("too small");

    // Invalid signature
    const badSig = new Uint8Array(100);
    await expect(NativeCReadOnlyDatabase.open(bridge.mod, new Blob([badSig]), 1)).rejects.toThrow("not a SQLite database");

    // Unsupported journal format
    const badJournal = bytes.slice();
    badJournal[18] = 3;
    await expect(NativeCReadOnlyDatabase.open(bridge.mod, new TestDatabaseBlob(badJournal), 1)).rejects.toThrow("unsupported SQLite journal format");

    // Missing capabilities
    const modWithoutWorkerFs = { ...bridge.mod, WORKERFS: undefined };
    await expect(NativeCReadOnlyDatabase.open(modWithoutWorkerFs, new TestDatabaseBlob(bytes), 1)).rejects.toThrow("does not support paged reads");

    vi.spyOn(bridge.mod, "_sqlite3_open_v2").mockImplementation((_path, output) => {
      bridge.mod.setValue(output, 0, "*");
      return 14;
    });
    await expect(NativeCReadOnlyDatabase.open(bridge.mod, new TestDatabaseBlob(bytes), 1)).rejects.toThrow("code 14");
    expect(bridge.workerFsMounts.size).toBe(0);
    expect(bridge.files.size).toBe(0);
  });

  it("validates batch sizes, tests hasMore, and allows idempotent close", async () => {
    const connection = await NativeCReadOnlyDatabase.open(bridge.mod, new TestDatabaseBlob(bytes), 1);
    try {
      const cursor = connection.startQuery("SELECT id FROM records ORDER BY id");
      expect(() => connection.readBatch(cursor.cursorId, 0)).toThrow("Invalid batch size");
      expect(() => connection.readBatch(cursor.cursorId, 1, 0)).toThrow("Invalid batch byte limit");

      expect(connection.hasMore(cursor.cursorId)).toBe(true);
      expect(connection.hasMore(cursor.cursorId)).toBe(true); // already positioned
      const batch = connection.readBatch(cursor.cursorId, 10);
      expect(batch.rows).toHaveLength(3);
      expect(batch.done).toBe(true);
      expect(connection.hasMore(cursor.cursorId)).toBe(false);
    } finally {
      connection.close();
      // Idempotent close
      connection.close();
    }
  });
});
