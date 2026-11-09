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
  const command = "docker buildx build";
  const child = spawn("docker", ["buildx", "build", "--target", "artifacts", "--output", `type=local,dest=${output}`,
    "-f", join(root, "build-wasm", "Dockerfile"), root], { stdio: "inherit", windowsHide: true });
  child.on("error", (error) => reject(new Error(`Could not start ${command}: ${error.message}`)));
  child.on("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    reject(new Error(`${command} failed (${reason}). Review the BuildKit output above for the failing step.`));
  });
});
const info = readNativeArtifacts(output);
console.log(`Built SpatiaLite ${info.components.spatialite} with GEOS, PROJ, and embedded proj.db: ${output}`);
