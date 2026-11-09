// SPDX-License-Identifier: LGPL-2.1-or-later
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNativeArtifacts, type NativeBuildInfo } from "../build/native-artifacts.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    if (!resolve(path).startsWith(`${resolve(tmpdir())}${sep}geolibre-native-check-`)) throw new Error("Unsafe temporary cleanup path.");
    await rm(path, {recursive:true, force:true});
  }
});
async function fixture(): Promise<{path: string; info: NativeBuildInfo}> {
  const path = await mkdtemp(join(tmpdir(),"geolibre-native-check-")); temporary.push(path);
  const names = ["spatialite.js","proj.db","licenses/libspatialite.txt","licenses/geos.txt","licenses/proj.txt","licenses/zlib.txt",
    "sources/sqlite-amalgamation-3460100.zip","sources/libspatialite-5.1.0.tar.gz","sources/geos-3.12.2.tar.bz2","sources/proj-9.4.1.tar.gz","sources/zlib-1.3.1.tar.gz"];
  const info: NativeBuildInfo = { format:1,engine:"native-c-wasm",singleFile:true,wasmBigInt:true,
    components:{sqlite:"3.46.1",spatialite:"5.1.0",geos:"3.12.2",proj:"9.4.1",zlib:"1.3.1",emscripten:"3.1.64"},files:{} };
  for (const name of names) {
    await mkdir(dirname(join(path,name)),{recursive:true});
    await writeFile(join(path,name),"Test metadata only; not a release artifact.");
    info.files[name] = createHash("sha256").update("Test metadata only; not a release artifact.").digest("hex");
  }
  await writeFile(join(path,"build-info.json"),JSON.stringify(info));
  return {path,info};
}
describe("native release artifact gate", () => {
  it("accepts complete checksummed build inputs and rejects a changed runtime", async () => {
    const {path,info} = await fixture();
    expect(readNativeArtifacts(path)).toEqual(info);
    await writeFile(join(path,"spatialite.js"),"stale output");
    expect(() => readNativeArtifacts(path)).toThrow("checksum mismatch");
  });
  it("rejects absent artifacts, missing upstream sources, and a different i64 ABI", async () => {
    const {path,info} = await fixture();
    expect(() => readNativeArtifacts(join(path,"missing"))).toThrow("build:wasm");
    delete info.files["sources/proj-9.4.1.tar.gz"];
    await writeFile(join(path,"build-info.json"),JSON.stringify(info));
    expect(() => readNativeArtifacts(path)).toThrow("corresponding sources");
    info.wasmBigInt = false;
    await writeFile(join(path,"build-info.json"),JSON.stringify(info));
    expect(() => readNativeArtifacts(path)).toThrow("metadata");
  });
  it("rejects unsafe file paths before reading outside the artifact directory", async () => {
    const {path,info} = await fixture();
    info.files["../outside"] = "untrusted";
    await writeFile(join(path,"build-info.json"),JSON.stringify(info));
    expect(() => readNativeArtifacts(path)).toThrow("artifact path");
  });
});
