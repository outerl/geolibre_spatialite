// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrowser } from "./browser-runner.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [filename, ...flags] = process.argv.slice(2);
const table = flags[0] && !flags[0].startsWith("--") ? flags.shift() : "links";
if (!filename) throw new Error("Usage: npm run benchmark:paged -- database.sqlite [table] [--column geometry] [--properties id,name] [--bbox minX,minY,maxX,maxY] [--require-index] [--compare-memory]");
const file = resolve(filename);
if (!(await stat(file)).isFile()) throw new Error("The benchmark input must be a database file.");
const query = new URLSearchParams({ table });
for (let i = 0; i < flags.length; i++) {
  const flag = flags[i];
  if (["--require-index", "--compare-memory"].includes(flag)) query.set(flag.slice(2), "1");
  else if (["--column", "--properties", "--bbox"].includes(flag)) {
    if (flags[i + 1] === undefined) throw new Error(`Missing value for ${flag}`);
    query.set(flag.slice(2), flags[++i]);
  } else throw new Error(`Unknown benchmark option: ${flag}`);
}
const contents = new Map([
  ["/dist/geolibre-spatialite.js", await readFile(join(root, "dist/geolibre-spatialite.js"))],
  ["/benchmark.mjs", await readFile(join(root, "scripts/benchmark-paged-browser.mjs"))],
]);
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (path === "/") {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end('<!doctype html><input id="database" type="file"><script type="module" src="/benchmark.mjs"></script>');
  } else if (contents.has(path)) {
    response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    response.end(contents.get(path));
  } else response.writeHead(path === "/favicon.ico" ? 204 : 404).end();
});
try {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const result = await runBrowser(`http://127.0.0.1:${address.port}/?${query}`, {
    timeoutMs: 600000, fileInputs: [{ selector: "#database", file }],
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
