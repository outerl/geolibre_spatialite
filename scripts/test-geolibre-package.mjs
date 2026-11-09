// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const distDir = join(rootDir, "geolibre-plugin", "dist");
const zipPath = join(distDir, `geolibre-spatialite-${pkg.version}.zip`);
const zip = await readFile(zipPath);
const shaData = JSON.parse(await readFile(`${zipPath}.sha256.json`, "utf8"));
assert.equal(createHash("sha256").update(zip).digest("hex"), shaData.sha256, "Archive checksum mismatch");
assert.equal(zip.length, shaData.bytes, "Archive size mismatch");
const end = zip.length - 22;
assert.equal(zip.readUInt32LE(end), 0x06054b50, "Missing ZIP end record");
const count = zip.readUInt16LE(end + 10);
let offset = zip.readUInt32LE(end + 16);
const files = new Map();
for (let i = 0; i < count; i++) {
  assert.equal(zip.readUInt32LE(offset), 0x02014b50, "Invalid central directory");
  const length = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
  const name = zip.subarray(offset + 46, offset + 46 + length).toString("utf8");
  assert(!name.startsWith("/") && !name.includes("\\") && !name.split("/").includes(".."), "Unsafe ZIP path");
  assert(!files.has(name), "Duplicate ZIP entry");
  const local = zip.readUInt32LE(offset + 42);
  assert.equal(zip.readUInt32LE(local), 0x04034b50, "Missing local header");
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(offset + 20)));
  assert.equal(data.length, zip.readUInt32LE(offset + 24), "Uncompressed size mismatch");
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  }
  assert.equal((crc ^ 0xffffffff) >>> 0, zip.readUInt32LE(offset + 16), `CRC mismatch for ${name}`);
  files.set(name, data);
  offset += 46 + length + extra + comment;
}
assert.equal(offset, end, "Unexpected central directory length");
const manifest = JSON.parse(files.get("plugin.json").toString("utf8"));
assert.equal(manifest.id, pkg.name);
assert.equal(manifest.version, pkg.version);
for (const required of [manifest.entry, manifest.style, "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCIES.json", "NATIVE_BUILD_INFO.json", "licenses/libspatialite.txt", "licenses/geos.txt", "licenses/proj.txt", "source/src/wasm/build-info.json", "source/src/wasm/spatialite.js", "source/src/wasm/proj.db", "source/package-lock.json", "source/src/geolibre.ts", "source/build/inline-sql-wasm-plugin.ts"]) {
  assert(files.has(required), `Missing package file: ${required}`);
}

// Import the JS extracted from the ZIP, initialize the inlined WASM, and exercise
// the public service offline. This catches broken exports and external assets.
const dom = new JSDOM("<!doctype html><div id='panel'></div>", { url: "https://geolibre.invalid" });
const original = new Map(["window", "document", "CustomEvent", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let db;
let plugin;
const app = {
  addGeoJsonLayer: () => "layer-1",
  registerRightPanel: (panel) => { panel.render(dom.window.document.getElementById("panel")); return () => {}; },
  registerToolbarMenu: () => () => {},
};
try {
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.fetch = () => { throw new Error("Unexpected network request in offline package"); };
  ({ default: plugin } = await import(`data:text/javascript;base64,${files.get(manifest.entry).toString("base64")}`));
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.activate(app), true);
  const service = dom.window.geolibreSpatialite;
  assert.equal(service.version, pkg.version);
  db = await service.createDatabase();
  assert.equal(service.getEngineType(), "native-c-wasm", "ZIP silently used the fallback engine");
  assert.equal(db.isNativeC, true);
  assert.match(db.getSpatialiteVersion(), /^5\.1\.0/);
  assert.equal(db.query("SELECT ST_Intersects(Buffer(MakePoint(0,0,4326),1),MakePoint(0,0,4326)) AS ok")[0].ok, 1);
  db.query("SELECT InitSpatialMetaData(1)");
  assert(Math.abs(db.query("SELECT X(Transform(MakePoint(10,0,4326),3857)) AS x")[0].x - 1113194.9079327357) < 0.01);
  db.exec("CREATE TABLE points(name TEXT, geometry BLOB)");
  db.exec("INSERT INTO points VALUES (?, MakePoint(?, ?, 4326))", ["Offline", 153, -27.5]);
  assert.deepEqual(db.getTableGeoJson("points").features[0]?.geometry, { type: "Point", coordinates: [153, -27.5] });
  assert(db.export().length > 0);
  db.close(); db = null;
  plugin.deactivate(app);
  assert.equal(dom.window.geolibreSpatialite, undefined);
  console.log(`Verified ZIP structure, ${files.size} entries, CRCs, SHA-256, and offline WASM/service smoke test: ${zipPath}`);
} finally {
  db?.close();
  plugin?.deactivate(app);
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  dom.window.close();
}
