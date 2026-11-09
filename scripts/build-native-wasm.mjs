// SPDX-License-Identifier: LGPL-2.1-or-later
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeArtifacts } from "../build/native-artifacts.ts";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "src", "wasm");
await mkdir(output, { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn("docker", ["buildx", "build", "--target", "artifacts", "--output", `type=local,dest=${output}`,
    "-f", join(root, "build-wasm", "Dockerfile"), root], { stdio: "inherit", windowsHide: true });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Native build failed (exit ${code}). Docker must be available and running.`)));
});
const info = readNativeArtifacts(output);
console.log(`Built SpatiaLite ${info.components.spatialite} with GEOS, PROJ, and embedded proj.db: ${output}`);
