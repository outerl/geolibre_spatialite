// SPDX-License-Identifier: LGPL-2.1-or-later
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dom = new JSDOM("<!doctype html>");
const globals = new Map(["window", "document", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let db, copy;
try {
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.fetch = () => { throw new Error("Native runtime attempted a network request"); };
  const library = await import(pathToFileURL(join(root, "dist", "geolibre-spatialite.js")).href);
  const service = library.getSpatialiteService();
  assert.equal(service.getEngineType(), "native-c-wasm", "The production build must use native SpatiaLite");
  db = await service.createDatabase();
  assert.equal(db.isNativeC, true);
  assert.match(db.getSpatialiteVersion(), /^5\.1\.0/);
  assert.equal(service.getSpatialiteVersion(), db.getSpatialiteVersion());
  assert.equal(db.hasGeos(), true);
  assert.equal(db.hasProj(), true);
  copy = await service.openDatabase(db.export());
  copy.close(); copy = null;

  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, payload BLOB); INSERT INTO items VALUES(1,'first',NULL); UPDATE items SET name='updated' WHERE id=1;");
  assert.equal(db.query("SELECT name FROM items")[0].name, "updated");
  db.exec("INSERT INTO items VALUES(?,?,?)", [9223372036854775807n, "nul\u0000text", new Uint8Array([0,255,3])]);
  const row = db.query("SELECT id,name,payload FROM items WHERE id=?", [9223372036854775807n])[0];
  assert.equal(row.id, 9223372036854775807n);
  assert.equal(row.name, "nul\u0000text");
  assert.deepEqual([...row.payload], [0,255,3]);
  assert.equal(db.query("SELECT typeof(?) AS kind", [9223372036854775807n])[0].kind, "integer");
  assert.equal(db.query("SELECT -9223372036854775808 AS value")[0].value, -9223372036854775808n);
  assert.throws(() => db.query("SELECT ?", [9223372036854775808n]), /64-bit/);
  assert.throws(() => db.query("SELECT ?", [Number.MAX_SAFE_INTEGER + 1]), /bigint/);

  const stmt = db.rawDb.prepare("SELECT ? AS a, ? AS b");
  try {
    stmt.bind([11,22]); assert.equal(stmt.step(), true); assert.deepEqual(stmt.get(), [11,22]);
    stmt.bind([33]); assert.equal(stmt.step(), true); assert.deepEqual(stmt.get(), [33,null]);
    assert.throws(() => stmt.bind([1,2,3]), /parameters/);
    stmt.bind([new Uint8Array(), null]); assert.equal(stmt.step(), true); assert.equal(stmt.get()[0].length, 0);
  } finally { stmt.free(); }
  assert.deepEqual(db.rawDb.exec("SELECT ? AS value", [42])[0].values, [[42]]);
  assert.throws(() => db.exec("INSERT INTO items(id) VALUES(?); DELETE FROM items", [2]), /single SQL/);
  assert.equal(db.query("SELECT count(*) AS n FROM items")[0].n, 2);

  // Exercise real GEOS and the embedded PROJ database, not feature-reporting stubs.
  assert.equal(db.query("SELECT ST_Intersects(Buffer(MakePoint(0,0,4326),1),MakePoint(0.5,0,4326)) AS value")[0].value, 1);
  db.query("SELECT InitSpatialMetaData(1)");
  const projected = db.query("SELECT X(Transform(MakePoint(10,0,4326),3857)) AS x")[0].x;
  assert(Math.abs(projected - 1113194.9079327357) < 0.01);
  db.exec("CREATE TABLE places(id INTEGER PRIMARY KEY)");
  assert.equal(db.query("SELECT AddGeometryColumn('places','geometry',4326,'POINT','XY') AS result")[0].result, 1);
  assert.equal(db.query("SELECT CreateSpatialIndex('places','geometry') AS result")[0].result, 1);
  db.exec("INSERT INTO places VALUES(1,MakePoint(153,-27.5,4326))");
  assert.equal(db.query("SELECT count(*) AS n FROM SpatialIndex WHERE f_table_name='places' AND search_frame=BuildMbr(152,-28,154,-27,4326)")[0].n, 1);

  const mod = await library.loadNativeSpatialiteWasm();
  const malloc = mod._malloc, free = mod._free, allocations = new Set();
  mod._malloc = (size) => { const ptr = malloc(size); allocations.add(ptr); return ptr; };
  mod._free = (ptr) => { allocations.delete(ptr); free(ptr); };
  try {
    for (let i=0;i<200;i++) db.rawDb.exec("SELECT 1; -- tail comment");
    assert.equal(allocations.size, 0, "Statement iteration leaked SQL allocations");
  } finally { mod._malloc=malloc; mod._free=free; }

  db.exec("BEGIN");
  assert.throws(() => db.export(), /transactions/);
  db.exec("ROLLBACK");
  db.exec("PRAGMA locking_mode=EXCLUSIVE");
  assert.equal(db.query("PRAGMA journal_mode=WAL")[0].journal_mode, "wal");
  db.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO items(id,name) VALUES(2,'WAL commit')");
  const bytes = db.export();
  copy = await service.openDatabase(bytes);
  assert.equal(copy.query("SELECT name FROM items WHERE id=2")[0].name, "WAL commit");
  assert.equal(copy.query("SELECT id FROM items WHERE id=?", [9223372036854775807n])[0].id, 9223372036854775807n);
  copy.close(); copy = null;
  await assert.rejects(() => service.openDatabase(new Uint8Array(100).fill(255)), /database|SpatiaLite/i);
  console.log("Native SpatiaLite verified: SQL/parameters, i64, GEOS, PROJ, spatial-index triggers, allocation cleanup, and WAL export/reopen.");
} finally {
  copy?.close(); db?.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }
  dom.window.close();
}
