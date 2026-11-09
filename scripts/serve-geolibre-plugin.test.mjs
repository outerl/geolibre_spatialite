// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { server } from "./serve-geolibre-plugin.mjs";

test("development server serves the manifest and blocks encoded traversal and writes", async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const get = (path, method = "GET") => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject); req.end();
  });
  try {
    assert.equal((await get("/plugin.json")).status, 200);
    assert.equal((await get("/%2e%2e/package.json")).status, 403);
    assert.equal((await get("/..%5cpackage.json")).status, 403);
    assert.equal((await get("/plugin.json", "POST")).status, 405);
    assert.equal((await get("/plugin.json", "HEAD")).text, "");
    assert.equal((await get("/%FF")).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
