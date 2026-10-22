import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const server = createServer(async (request, response) => {
  const requested = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) { response.writeHead(403); response.end("Forbidden"); return; }
  try { const content = await readFile(file); response.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" }); response.end(content); }
  catch { response.writeHead(404); response.end("Not found"); }
});
server.listen(4173, "127.0.0.1", () => console.log("Xiao Yu preview: http://127.0.0.1:4173"));
