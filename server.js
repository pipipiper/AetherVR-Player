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
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};

/* ── HLS 实时转码 ─────────────────────────────────────────────
 * 手机硬解不了 8K HEVC 时，由本机 ffmpeg 实时转成 4K H.264 HLS，
 * iPhone Safari 原生支持 HLS 播放与进度拖动。
 * 同时只保留一个转码会话（本机单用户场景）。 */
const { spawn } = require("child_process");
const os = require("os");

const HLS_ROOT = path.join(os.tmpdir(), "vr-player-hls");
const FFMPEG =
  [process.env.FFMPEG, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(
    (p) => p && fs.existsSync(p)
  ) || "ffmpeg";

let hlsSession = null; // { id, proc, dir }

function killHlsSession() {
  if (hlsSession) {
    try { hlsSession.proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(hlsSession.dir, { recursive: true, force: true }); } catch {}
    hlsSession = null;
  }
}

// 启动时清理上次遗留的分片目录
try { fs.rmSync(HLS_ROOT, { recursive: true, force: true }); } catch {}

function startTranscode(target, res) {
  killHlsSession();
  const id = Date.now().toString(36);
  const dir = path.join(HLS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });

  const proc = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error",
    "-i", target,
    "-c:v", "h264_videotoolbox",   // Apple 硬件编码，8K 也能跑实时
    "-b:v", "10M",
    "-vf", "scale=3840:-2",        // 8K SBS → 4K，iPhone 可硬解
    "-c:a", "copy",                // 音源是 AAC，直接透传省 CPU
    "-f", "hls",
    "-hls_time", "4",
    "-hls_playlist_type", "event", // 增长的播放列表，支持在已生成分片内拖动
    "-hls_flags", "independent_segments",
    path.join(dir, "index.m3u8"),
  ]);
  let errBuf = "";
  proc.stderr.on("data", (d) => { errBuf += d.toString(); });
  hlsSession = { id, proc, dir };
  proc.on("exit", () => {
    if (hlsSession && hlsSession.id === id) hlsSession = null;
  });

  // 轮询等待首个分片就绪（8K 启动需要十几秒，最多等 90 秒）
  const playlist = path.join(dir, "index.m3u8");
  const started = Date.now();
  const timer = setInterval(() => {
    let segReady = false;
    try {
      segReady =
        fs.existsSync(playlist) &&
        fs.readdirSync(dir).some((f) => f.endsWith(".ts"));
    } catch {}
    if (segReady || Date.now() - started > 90000) {
      clearInterval(timer);
      if (segReady) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ playlist: `/hls/${id}/index.m3u8` }));
      } else {
        killHlsSession();
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "转码启动失败：" + errBuf.slice(-300) }));
      }
    }
  }, 500);
}

process.on("SIGTERM", () => { killHlsSession(); process.exit(0); });
process.on("SIGINT", () => { killHlsSession(); process.exit(0); });
process.on("exit", killHlsSession);

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
    if (urlPath === "/transcode") {
      const target = new URL(req.url, "http://local").searchParams.get("url");
      if (!target) {
        res.writeHead(400).end("Missing url parameter");
        return;
      }
      try {
        const u = new URL(target);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      } catch {
        res.writeHead(400).end("Only http(s) URLs allowed");
        return;
      }
      startTranscode(target, res);
      return;
    }
    if (urlPath.startsWith("/hls/")) {
      const file = path.join(HLS_ROOT, path.normalize(urlPath.slice(5)));
      if (!file.startsWith(HLS_ROOT)) {
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
      return;
    }
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
