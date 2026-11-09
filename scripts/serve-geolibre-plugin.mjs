import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = await realpath(resolve(rootDir, "geolibre-plugin"));
const port = Number(process.env.PORT || 4174);
const mimeTypes = { ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".zip": "application/zip" };
export function withinBundle(path) {
  const rel = relative(bundleDir, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  try {
    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    const requested = resolve(bundleDir, path === "/" ? "plugin.json" : path.replace(/^\//, ""));
    if (!withinBundle(requested)) { res.writeHead(403); res.end(); return; }
    const actual = await realpath(requested);
    if (!withinBundle(actual)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(actual)).isFile()) { res.writeHead(404); res.end(); return; }
    const data = await readFile(actual);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(actual)] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch { res.writeHead(404); res.end(); }
});
if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Serving geolibre-spatialite at http://127.0.0.1:${port}/plugin.json`);
  });
}
