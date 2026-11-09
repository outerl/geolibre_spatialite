// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrowser } from "./browser-runner.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packaged = process.argv.includes("--package");
const bundle = packaged ? "index.js" : "geolibre-spatialite.js";
const paths = new Map([
  [`/dist/${bundle}`, join(root, packaged ? "geolibre-plugin/dist" : "dist", bundle)],
  ["/scripts/native-browser-fixture.mjs", join(root, "scripts/native-browser-fixture.mjs")],
]);
const contents = new Map(await Promise.all([...paths].map(async ([route, file]) => [route, await readFile(file)])));
const unexpected = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      // Blob workers inherit this policy: native runtime resources must be
      // embedded, with no fetch/XHR connections on the page or in its workers.
      "Content-Security-Policy": "default-src 'none'; script-src 'self' blob: data: 'unsafe-eval'; worker-src blob: data:; connect-src 'none'; style-src 'self' 'unsafe-inline'",
    });
    response.end('<!doctype html><div id="panel"></div><script type="module" src="/scripts/native-browser-fixture.mjs"></script>');
  } else if (contents.has(url.pathname)) {
    response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    response.end(contents.get(url.pathname));
  } else if (url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
  } else {
    unexpected.push(url.pathname);
    response.writeHead(404).end();
  }
});
try {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const result = await runBrowser(`http://127.0.0.1:${address.port}/${packaged ? "?package=1" : ""}`);
  if (unexpected.length) throw new Error(`Standalone native bundle requested unexpected assets: ${unexpected.join(", ")}`);
  console.log(`Native browser worker verified (${packaged ? "plugin" : "library"}): ${JSON.stringify(result)}`);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
