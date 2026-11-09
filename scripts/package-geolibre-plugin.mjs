// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = join(rootDir, "geolibre-plugin");
const distDir = join(bundleDir, "dist");
const manifestPath = join(bundleDir, "plugin.json");
const generatedManifestPath = join(distDir, "plugin.json");
const crcTable = createCrcTable();

await mkdir(distDir, { recursive: true });

const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version !== pkg.version) throw new Error("package.json and plugin.json versions must match.");
if (!/^[a-z0-9-]+$/.test(manifest.id)) throw new Error("Invalid plugin ID.");
for (const path of [manifest.entry, manifest.style]) {
  if (!path || !/^dist\/[a-zA-Z0-9._-]+$/.test(path)) throw new Error("Invalid bundle path.");
}
await writeFile(generatedManifestPath, JSON.stringify(manifest, null, 2) + "\n");
const outputPath = join(distDir, `${manifest.id}-${manifest.version}.zip`);
const entries = [
  ["plugin.json", generatedManifestPath],
  [manifest.entry, join(bundleDir, manifest.entry)],
];

if (manifest.style) entries.push([manifest.style, join(bundleDir, manifest.style)]);
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) entries.push([name, join(rootDir, name)]);
const dependencies = {};
for (const [name, license] of [["sql.js", "LICENSE"], ["proj4", "LICENSE.md"], ["mgrs", "license.md"], ["wkt-parser", "LICENSE.md"]]) {
  entries.push([`licenses/${name}.txt`, join(rootDir, "node_modules", name, license)]);
  dependencies[name] = JSON.parse(await readFile(join(rootDir, "node_modules", name, "package.json"), "utf8")).version;
}
const dependencyPath = join(distDir, "DEPENDENCIES.json");
await writeFile(dependencyPath, JSON.stringify(dependencies, null, 2) + "\n");
entries.push(["DEPENDENCIES.json", dependencyPath]);
for (const directory of ["src", "build", "scripts", "tests", "docs", "geolibre-plugin"]) {
  await addSources(directory);
}
for (const name of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "vite.config.ts", "vite.geolibre.config.ts", "vitest.config.ts", "eslint.config.js", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  entries.push([`source/${name}`, join(rootDir, name)]);
}
entries.sort(([a], [b]) => a.localeCompare(b, "en"));
const archive = await createZip(entries);
await writeFile(outputPath, archive);
await writeFile(
  `${outputPath}.sha256.json`,
  `${JSON.stringify({ algorithm: "sha256", sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.length }, null, 2)}\n`,
);
console.log(`Created ${outputPath}`);

async function addSources(directory) {
  for (const entry of await readdir(join(rootDir, directory), { withFileTypes: true })) {
    if (entry.name === "dist") continue;
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await addSources(name);
    else if (entry.isFile()) entries.push([`source/${name}`, join(rootDir, name)]);
  }
}

async function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, path] of files) {
    const rawData = await readFile(path);
    const data = deflateRawSync(rawData);
    const encodedName = Buffer.from(name, "utf8");
    const crc = crc32(rawData);
    const { date, time } = dosDateTime(new Date("2024-01-01T00:00:00Z"));
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8); // Deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(encodedName.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, encodedName, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10); // Deflate
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(encodedName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt32LE(0, 36);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, encodedName);

    offset += localHeader.length + encodedName.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectorySize, 12);
  endRecord.writeUInt32LE(centralDirectoryOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let current = index;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[index] = current >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (Math.floor(date.getUTCSeconds() / 2));
  return { date: dosDate, time: dosTime };
}
