// SPDX-License-Identifier: LGPL-2.1-or-later
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeCDatabase } from "../src/spatialite/c-wasm-adapter.js";
import { SpatialiteDatabase } from "../src/spatialite/database.js";
import { getActiveEngineType, getLoadedSpatialiteVersion, registerNativeSpatialiteFactory } from "../src/spatialite/sqlite-engine.js";
import { createRealSqliteModule } from "./helpers/real-sqlite-wasm.js";

let bridge: Awaited<ReturnType<typeof createRealSqliteModule>>;
const opened: NativeCDatabase[] = [];
function open(data?: Uint8Array): NativeCDatabase { const db = NativeCDatabase.open(bridge.mod, data); opened.push(db); return db; }
beforeAll(async () => { bridge = await createRealSqliteModule(); });
afterEach(() => {
  vi.restoreAllMocks(); registerNativeSpatialiteFactory(null);
  for (const db of opened.splice(0)) db.close();
  expect(bridge.allocations.size).toBe(0);
  expect(bridge.files.size).toBe(0);
});
afterAll(() => { bridge.close(); });

describe("native adapter with real SQLite C execution", () => {
  it("executes all statements, bound SQL, and CTEs", () => {
    const db = open();
    db.run("CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO items VALUES(1,'first'); UPDATE items SET label='updated' WHERE id=1;");
    expect(db.exec("SELECT label FROM items")[0]?.values).toEqual([["updated"]]);
    db.run("INSERT INTO items VALUES(?,?)", [2,"O'Brien"]);
    expect(db.exec("SELECT label FROM items WHERE id=?", [2])[0]?.values).toEqual([["O'Brien"]]);
    expect(db.exec("WITH x AS (SELECT 7 AS answer) SELECT * FROM x; SELECT 9;").map((r) => r.values)).toEqual([[[7]],[[9]]]);
    db.run("-- only a comment");
    expect(() => { db.run("INSERT INTO items VALUES(?,?); DELETE FROM items", [3,"third"]); }).toThrow("single SQL");
    expect(db.exec("SELECT count(*) FROM items")[0]?.values).toEqual([[2]]);
  });
  it("preserves signed 64-bit integers and rejects lossy or overflowing parameters", () => {
    const db = open();
    db.run("CREATE TABLE integers(id INTEGER)");
    db.run("INSERT INTO integers VALUES(?)", [9223372036854775807n]);
    db.run("INSERT INTO integers VALUES(?)", [-9223372036854775808n]);
    expect(db.exec("SELECT id FROM integers ORDER BY id")[0]?.values).toEqual([[-9223372036854775808n],[9223372036854775807n]]);
    expect(() => db.exec("SELECT ?", [9223372036854775808n])).toThrow("64-bit");
    expect(() => db.exec("SELECT ?", [Number.MAX_SAFE_INTEGER + 1])).toThrow("bigint");
    expect(db.exec("SELECT 4.25, NULL")[0]?.values).toEqual([[4.25,null]]);
  });
  it("clears stale bindings and reports parameter and SQLite binding errors", () => {
    const db = open(), stmt = db.prepare("SELECT ? AS a, ? AS b");
    try {
      stmt.bind([11,22]); expect(stmt.step()).toBe(true); expect(stmt.getAsObject()).toEqual({a:11,b:22});
      stmt.bind([33]); expect(stmt.step()).toBe(true); expect(stmt.get()).toEqual([33,null]);
      stmt.bind(); expect(stmt.step()).toBe(true); expect(stmt.get()).toEqual([null,null]);
      expect(() => stmt.bind([1,2,3])).toThrow("parameters");
      vi.spyOn(bridge.mod,"_sqlite3_bind_text").mockReturnValueOnce(7);
      expect(() => stmt.bind(["text"])).toThrow("code 7");
    } finally { stmt.free(); }
  });
  it("round-trips UTF-8, embedded NULs, empty BLOBs, and safe object keys", () => {
    const db = open();
    const result = db.exec('SELECT ? AS "__proto__", ? AS data, ? AS empty', ["café\u0000tail",new Uint8Array([0,255,3]),new Uint8Array()])[0];
    expect(result?.values).toEqual([["café\u0000tail",new Uint8Array([0,255,3]),new Uint8Array()]]);
    const stmt = db.prepare('SELECT 1 AS "__proto__"');
    try { stmt.step(); expect(Object.hasOwn(stmt.getAsObject(),"__proto__")).toBe(true); } finally { stmt.free(); }
  });
  it("frees SQL allocations and statements on success, errors, and early iterator exits", () => {
    const db = open();
    for (let i=0;i<100;i++) db.exec("SELECT 1; -- comment\nSELECT 2");
    expect(bridge.allocations.size).toBe(0);
    expect(() => db.exec("SELECT 1; invalid SQL")).toThrow();
    for (const stmt of db.iterateStatements("SELECT 1; SELECT 2")) { stmt.step(); break; }
    expect(bridge.allocations.size).toBe(0);
    expect(() => db.prepare("-- empty SQL")).toThrow("empty");
    vi.spyOn(bridge.mod,"_malloc").mockReturnValueOnce(0);
    expect(() => db.prepare("SELECT 1")).toThrow("memory allocation");
  });
  it("surfaces constraint and preparation errors and finalizes statements on close", () => {
    const db = open(); db.run("CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1)");
    expect(() => { db.run("INSERT INTO items VALUES(1)"); }).toThrow(/UNIQUE|constraint/i);
    expect(() => db.prepare("not SQL")).toThrow();
    const stmt = db.prepare("SELECT * FROM items");
    const iterator = db.iterateStatements("SELECT 1; SELECT 2");
    iterator.next();
    db.close(); expect(() => stmt.step()).toThrow("finalized"); expect(() => db.exec("SELECT 1")).toThrow("closed");
    iterator.return?.();
    expect(() => { db.close(); }).not.toThrow();
  });
  it("serializes a live connection and reopens every committed value", () => {
    const db = open(); db.run("CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(42)");
    const copy = open(db.export());
    expect(copy.exec("SELECT * FROM items")[0]?.values).toEqual([[42]]);
    db.run("BEGIN; INSERT INTO items VALUES(99)");
    expect(() => db.export()).toThrow("transactions"); db.run("ROLLBACK");
    const stmt = db.prepare("SELECT * FROM items");
    expect(() => db.export()).toThrow("active statements"); stmt.free();
    vi.spyOn(bridge.mod,"_sqlite3_serialize").mockImplementationOnce((_db,_schema,size) => {
      new DataView(bridge.mod.HEAPU8.buffer).setBigInt64(size,4096n,true);
      return 0;
    });
    expect(() => db.export()).toThrow("serialize");
  });
  it("exports WAL-format snapshots as portable standalone SQLite files", () => {
    const db = open(); db.run("CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(42)");
    const serialize = bridge.mod._sqlite3_serialize.bind(bridge.mod);
    vi.spyOn(bridge.mod,"_sqlite3_serialize").mockImplementation((...args) => {
      const ptr = serialize(...args);
      bridge.mod.HEAPU8[ptr + 18] = 2; bridge.mod.HEAPU8[ptr + 19] = 2;
      return ptr;
    });
    const bytes = db.export(), copy = open(bytes);
    expect(copy.exec("SELECT * FROM items")[0]?.values).toEqual([[42]]);
    expect([bytes[18],bytes[19]]).toEqual([1,1]);
  });
  it("can export and reopen an empty database", () => {
    const db = open(), copy = open(db.export());
    expect(copy.exec("SELECT name FROM sqlite_master")[0]?.values).toEqual([]);
  });
  it("cleans up failed opening and initialization", () => {
    expect(() => open(new Uint8Array(100).fill(255))).toThrow(/database/i);
    vi.spyOn(bridge.mod,"_spatialite_wasm_init").mockReturnValueOnce(0);
    expect(() => open()).toThrow("initialization");
  });
  it("loads the registered factory once, reports its actual version, and retries failures", async () => {
    const factory = vi.fn().mockRejectedValueOnce(new Error("transient initialization failure")).mockResolvedValue(bridge.mod);
    registerNativeSpatialiteFactory(factory);
    expect(getActiveEngineType()).toBe("native-c-wasm");
    expect(getLoadedSpatialiteVersion()).toBe("not initialized");
    await expect(SpatialiteDatabase.open()).rejects.toThrow("transient");
    const a = await SpatialiteDatabase.open(), b = await SpatialiteDatabase.open();
    try {
      expect(factory).toHaveBeenCalledTimes(2);
      expect(a.isNativeC).toBe(true); expect(a.getSpatialiteVersion()).toBe("5.1.0 (SQLite test bridge)");
      expect(getLoadedSpatialiteVersion()).toBe(a.getSpatialiteVersion());
      expect(a.hasGeos()).toBe(false); expect(a.hasProj()).toBe(false);
      a.exec("CREATE TABLE places(id INTEGER, geometry BLOB)");
      a.exec("INSERT INTO places VALUES(?,NULL)",[9223372036854775807n]);
      expect(a.getTableGeoJson("places").features[0]?.properties?.id).toBe("9223372036854775807");
      a.transaction(() => { a.exec("INSERT INTO places VALUES(1,NULL)"); });
    } finally { a.close(); b.close(); }
  });
});
