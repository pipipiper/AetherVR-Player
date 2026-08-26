#!/usr/bin/env node
/* Zero-dependency static server for the local VR player.
 * Forwards --host / --port (and --host=.. / --port=..) CLI args. */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.findIndex((a) => a === `--${name}` || a === name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  return fallback;
}
const HOST = arg("host", "127.0.0.1");
const PORT = Number(arg("port", 7100));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/* Same-origin video proxy: forwards Range headers, follows redirects.
 * Lets the player use remote URLs as WebGL textures (VR mode) even when
 * the remote server sends no CORS headers. */
function proxyVideo(target, req, res, redirects) {
  let u;
  try {
    u = new URL(target);
  } catch {
    res.writeHead(400).end("Bad proxy URL");
    return;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    res.writeHead(400).end("Only http(s) URLs allowed");
    return;
  }
  const lib = u.protocol === "https:" ? https : http;
  const headers = { "User-Agent": req.headers["user-agent"] || "Mozilla/5.0" };
  if (req.headers.range) headers.Range = req.headers.range;
  const preq = lib.get(u, { headers }, (pres) => {
    if (
      [301, 302, 303, 307, 308].includes(pres.statusCode) &&
      pres.headers.location &&
      redirects < 5
    ) {
      pres.resume();
      proxyVideo(new URL(pres.headers.location, u).href, req, res, redirects + 1);
      return;
    }
    const h = {
      "Accept-Ranges": pres.headers["accept-ranges"] || "bytes",
      "Cache-Control": "no-cache",
    };
    if (pres.headers["content-length"]) h["Content-Length"] = pres.headers["content-length"];
    if (pres.headers["content-range"]) h["Content-Range"] = pres.headers["content-range"];
    let ct = pres.headers["content-type"] || "";
    if (!ct || ct === "application/octet-stream") ct = "video/mp4";
    h["Content-Type"] = ct;
    res.writeHead(pres.statusCode, h);
    pres.pipe(res);
  });
  preq.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Proxy error: " + e.message);
  });
  req.on("close", () => preq.destroy());
}

const server = http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/proxy") {
      const target = new URL(req.url, "http://local").searchParams.get("url");
      if (!target) {
        res.writeHead(400).end("Missing url parameter");
        return;
      }
      proxyVideo(target, req, res, 0);
      return;
    }
    if (urlPath === "/") urlPath = "/index.html";
    const file = path.join(__dirname, path.normalize(urlPath));
    if (!file.startsWith(__dirname)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  });

// "localhost" may resolve to ::1 only, which would make the server unreachable
// via http://127.0.0.1:<port>/. Bind to the unspecified address (dual-stack)
// in that case so both IPv4 and IPv6 loopback work.
if (HOST === "localhost" || HOST === "::1") {
  server.listen(PORT, () => {
    console.log(`VR Player running at http://localhost:${PORT}/ (also via 127.0.0.1)`);
  });
} else {
  server.listen(PORT, HOST, () => {
    console.log(`VR Player running at http://${HOST}:${PORT}/`);
  });
}
