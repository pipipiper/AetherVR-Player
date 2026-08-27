#!/usr/bin/env node
/* Zero-dependency static server for the local VR player.
 * Forwards --host / --port (and --host=.. / --port=..) CLI args. */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");

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

/* --local-fs（仅 Electron 桌面端传入）：开放 /local 与 /local-check，
 * 允许页面按绝对路径流式读取本机磁盘文件（带 Range，可拖动进度）。
 * 网页部署时绝不带此开关。 */
const LOCAL_FS = args.includes("--local-fs");
const VIDEO_MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".ogv": "video/ogg", ".ogg": "video/ogg", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ts": "video/mp2t",
  ".m2ts": "video/mp2t", ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv",
  ".3gp": "video/3gpp",
};

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
  [process.env.FFMPEG, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find(
    (p) => p && fs.existsSync(p)
  ) || "ffmpeg";
const FFPROBE =
  [process.env.FFPROBE, "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"].find(
    (p) => p && fs.existsSync(p)
  ) || "ffprobe";

// macOS 用 VideoToolbox 硬编；Linux（无 GPU 直通）用 libx264 软编。
// 110 服务器没有可用的硬件编码器：优先稳定实时软编，再根据实测调整画质。
const IS_MAC = process.platform === "darwin";
const VIDEO_ENCODER = IS_MAC
  ? ["-c:v", "h264_videotoolbox", "-b:v", "12M"]
  : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "21", "-threads", "16"];

const HLS_IDLE_MS = 2 * 60 * 1000;
const HLS_MAX_MS = 2 * 60 * 60 * 1000;
// 冷却只防恶意刷接口：快进重启转码也走 /transcode，不能定得太长
const TRANSCODE_COOLDOWN_MS = 4 * 1000;
const PROBE_COOLDOWN_MS = 2 * 1000;
const transcodeStarts = new Map();
const probeStarts = new Map();
let hlsSession = null;

function stopHlsSession(session = hlsSession) {
  if (!session) return;
  clearInterval(session.startTimer);
  if (session.proc && session.proc.exitCode === null) {
    try { session.proc.kill("SIGKILL"); } catch {}
  }
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {}
  if (hlsSession === session) hlsSession = null;
}

setInterval(() => {
  if (!hlsSession) return;
  const now = Date.now();
  if (now - hlsSession.lastAccess > HLS_IDLE_MS || now - hlsSession.startedAt > HLS_MAX_MS) {
    stopHlsSession(hlsSession);
  }
}, 30000);

// 启动时清理上次遗留的分片目录
try { fs.rmSync(HLS_ROOT, { recursive: true, force: true }); } catch {}

// FFmpeg 在打开输入后会打印 Duration；直接复用转码进程的信息，
// 避免另启 ffprobe 重复读取远程大文件或占用签名链接的并发数。
function parseFfmpegDuration(text) {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function localProxyInput(target) {
  const localHost = ["0.0.0.0", "::", "::1", "localhost"].includes(HOST) ? "127.0.0.1" : HOST;
  const localAuthority = net.isIP(localHost) === 6 ? `[${localHost}]` : localHost;
  return `http://${localAuthority}:${PORT}/proxy?url=${encodeURIComponent(target)}`;
}

function startTranscode(target, ownerIp, res, start = 0) {
  if (hlsSession) stopHlsSession(hlsSession);
  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(HLS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });

  const proxyInput = localProxyInput(target);
  const proc = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "info", "-nostdin",
    "-rw_timeout", "15000000",
    // 从指定时间点开始转码（快进重启）。-ss 放在 -i 前走 HTTP Range 快速
    // 定位，重编码下输出帧精确；输出时间轴从 0 开始，前端自行加偏移显示。
    ...(start > 0 ? ["-ss", start.toFixed(3)] : []),
    "-i", proxyInput,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...VIDEO_ENCODER,
    "-vf", "scale=w='min(3840,iw)':h=-2:flags=bicubic,format=yuv420p",
    "-pix_fmt", "yuv420p",
    "-force_key_frames", "expr:gte(t,n_forced*4)",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
    "-max_muxing_queue_size", "2048",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(dir, "segment-%06d.ts"),
    path.join(dir, "index.m3u8"),
  ]);
  const session = {
    id, proc, dir, ownerIp,
    startedAt: Date.now(),
    lastAccess: Date.now(),
    ready: false,
    exited: false,
    error: "",
    duration: null,
    durationProbe: "",
    startTimer: null,
  };
  hlsSession = session;
  proc.stderr.on("data", (d) => {
    const text = d.toString();
    session.error = (session.error + text).slice(-4096);
    if (session.duration === null) {
      session.durationProbe = (session.durationProbe + text).slice(-32768);
      session.duration = parseFfmpegDuration(session.durationProbe);
      if (session.duration !== null) session.durationProbe = "";
    }
  });
  proc.once("error", (err) => {
    session.exited = true;
    session.error = err.message;
  });
  proc.once("exit", (code, signal) => {
    session.exited = true;
    if (code && !session.error) session.error = `ffmpeg exited with code ${code}${signal ? ` (${signal})` : ""}`;
  });

  // 轮询等待首个分片就绪（8K 启动需要十几秒，最多等 90 秒）
  const playlist = path.join(dir, "index.m3u8");
  const started = Date.now();
  session.startTimer = setInterval(() => {
    let segReady = false;
    try {
      segReady =
        fs.existsSync(playlist) &&
        fs.readdirSync(dir).some((f) => f.endsWith(".ts"));
    } catch {}
    const failed = session.exited && !segReady;
    if (segReady || failed || Date.now() - started > 90000) {
      clearInterval(session.startTimer);
      session.startTimer = null;
      if (segReady) {
        session.ready = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ playlist: `/hls/${id}/index.m3u8`, duration: session.duration, start }));
      } else {
        stopHlsSession(session);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "转码启动失败：" + session.error.slice(-500) }));
      }
    }
  }, 500);

  res.once("close", () => {
    if (!res.writableEnded && !session.ready) stopHlsSession(session);
  });
}

/* ffprobe 远程视频信息探测：只读容器/流头（配合 Range 秒级返回），
 * 让前端在尝试播放前就知道编码是否可能不支持，避免长时间黑屏。 */
function probeRemoteMedia(target, res) {
  const proxyInput = localProxyInput(target);
  const proc = spawn(FFPROBE, [
    "-v", "error",
    "-rw_timeout", "15000000",
    "-show_entries", "stream=codec_type,codec_name,width,height:format=format_name",
    "-of", "json",
    proxyInput,
  ]);
  let out = "";
  let err = "";
  const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 15000);
  proc.stdout.on("data", (d) => {
    out += d;
    if (out.length > 1024 * 1024) {
      err = "probe output too large";
      try { proc.kill("SIGKILL"); } catch {}
    }
  });
  proc.stderr.on("data", (d) => { err = (err + d.toString()).slice(-2048); });
  const fail = (message) => {
    if (res.writableEnded) return;
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  };
  proc.once("error", (e) => { clearTimeout(killer); fail("ffprobe 不可用：" + e.message); });
  proc.once("close", (code) => {
    clearTimeout(killer);
    if (res.writableEnded) return;
    if (code !== 0) return fail("探测失败：" + (err.trim().slice(-300) || `ffprobe exited ${code}`));
    try {
      const parsed = JSON.parse(out);
      const streams = parsed.streams || [];
      const v = streams.find((s) => s.codec_type === "video");
      const a = streams.find((s) => s.codec_type === "audio");
      const format = parsed.format || {};
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        video: v ? { codec: v.codec_name || "", width: v.width || 0, height: v.height || 0 } : null,
        audio: a ? { codec: a.codec_name || "" } : null,
        formatName: format.format_name || "",
      }));
    } catch {
      fail("探测结果解析失败");
    }
  });
  res.once("close", () => {
    if (!res.writableEnded && proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  });
}

process.on("SIGTERM", () => { stopHlsSession(); process.exit(0); });
process.on("SIGINT", () => { stopHlsSession(); process.exit(0); });
process.on("exit", () => stopHlsSession());

/* Same-origin video proxy: forwards Range headers, follows redirects.
 * Lets the player use remote URLs as WebGL textures (VR mode) even when
 * the remote server sends no CORS headers. */
function isBlockedAddress(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value.startsWith("::ffff:")) return isBlockedAddress(value.slice(7));
  const version = net.isIP(value);
  if (version === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    return value === "::" || value === "::1"
      || value.startsWith("fc") || value.startsWith("fd")
      || /^fe[89ab]/.test(value) || value.startsWith("ff")
      || value.startsWith("2001:db8:");
  }
  return true;
}

async function resolveSafeTarget(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error("Only http(s) URLs allowed");
  if (u.username || u.password) throw new Error("Credentials in URLs are not allowed");
  const isOlPippMedia = u.hostname.toLowerCase() === "ol.pipp.cc" && u.port === "19766";
  if (u.port && !['80', '443', '8443'].includes(u.port) && !isOlPippMedia) {
    throw new Error("This source host and port are not allowed");
  }
  const addresses = await dns.lookup(u.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address))) {
    throw new Error("Private or reserved network targets are not allowed");
  }
  return addresses[0];
}

async function proxyVideo(target, req, res, redirects = 0) {
  let u;
  try {
    u = new URL(target);
  } catch {
    res.writeHead(400).end("Bad proxy URL");
    return;
  }
  let resolved;
  try {
    resolved = await resolveSafeTarget(u);
  } catch (err) {
    res.writeHead(403).end(err.message);
    return;
  }
  const lib = u.protocol === "https:" ? https : http;
  const headers = {
    "Host": u.host,
    "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
    "Accept": req.headers.accept || "*/*",
  };
  if (req.headers.range) headers.Range = req.headers.range;
  const options = {
    protocol: u.protocol,
    hostname: resolved.address,
    family: resolved.family,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    headers,
  };
  if (u.protocol === "https:" && !net.isIP(u.hostname)) options.servername = u.hostname;
  const preq = lib.get(options, (pres) => {
    if (
      [301, 302, 303, 307, 308].includes(pres.statusCode) &&
      pres.headers.location
    ) {
      pres.resume();
      if (redirects >= 5) {
        res.writeHead(502).end("Too many redirects");
        return;
      }
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
  preq.setTimeout(15000, () => preq.destroy(new Error("Upstream timeout")));
  req.on("aborted", () => preq.destroy());
  res.on("close", () => {
    if (!res.writableEnded) preq.destroy();
  });
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || "")
    .split(",")[0].trim();
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const server = http
  .createServer(async (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      res.writeHead(400).end("Bad URL encoding");
      return;
    }
    if (urlPath === "/transcode") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Allow": "POST" }).end("Method not allowed");
        return;
      }
      const origin = req.headers.origin;
      try {
        if (!origin || new URL(origin).host !== req.headers.host) {
          res.writeHead(403).end(JSON.stringify({ error: "Same-origin request required" }));
          return;
        }
      } catch {
        res.writeHead(403).end(JSON.stringify({ error: "Invalid Origin" }));
        return;
      }
      const ip = clientIp(req);
      const previousStart = transcodeStarts.get(ip) || 0;
      if (Date.now() - previousStart < TRANSCODE_COOLDOWN_MS) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "4" });
        res.end(JSON.stringify({ error: "操作过于频繁，请稍后重试" }));
        return;
      }
      if (hlsSession && hlsSession.ownerIp !== ip) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "服务器正在为另一位用户转码，请稍后重试" }));
        return;
      }
      let target;
      let start = 0;
      try {
        const body = await readJson(req);
        target = typeof body.url === "string" ? body.url.trim() : "";
        if (!target || target.length > 4096) throw new Error("Invalid video URL");
        const u = new URL(target);
        await resolveSafeTarget(u);
        // 可选：从该秒数开始转码（前端快进重启）。范围钳制到 [0, 12h]。
        const startRaw = Number(body.start);
        if (Number.isFinite(startRaw) && startRaw > 0) {
          start = Math.min(startRaw, 12 * 3600);
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      transcodeStarts.set(ip, Date.now());
      startTranscode(target, ip, res, start);
      return;
    }
    if (urlPath === "/transcode/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ffmpeg: fs.existsSync(FFMPEG),
        active: Boolean(hlsSession),
        ready: Boolean(hlsSession && hlsSession.ready),
        encoder: IS_MAC ? "h264_videotoolbox" : "libx264",
      }));
      return;
    }
    if (urlPath === "/probe") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Allow": "POST" }).end("Method not allowed");
        return;
      }
      const origin = req.headers.origin;
      try {
        if (!origin || new URL(origin).host !== req.headers.host) {
          res.writeHead(403).end(JSON.stringify({ error: "Same-origin request required" }));
          return;
        }
      } catch {
        res.writeHead(403).end(JSON.stringify({ error: "Invalid Origin" }));
        return;
      }
      const ip = clientIp(req);
      const lastProbe = probeStarts.get(ip) || 0;
      if (Date.now() - lastProbe < PROBE_COOLDOWN_MS) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "操作过于频繁" }));
        return;
      }
      let target;
      try {
        const body = await readJson(req);
        target = typeof body.url === "string" ? body.url.trim() : "";
        if (!target || target.length > 4096) throw new Error("Invalid video URL");
        await resolveSafeTarget(new URL(target));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      probeStarts.set(ip, Date.now());
      probeRemoteMedia(target, res);
      return;
    }
    if (urlPath.startsWith("/hls/")) {
      const parts = urlPath.slice(5).split("/");
      const session = hlsSession;
      const filename = parts[1] || "";
      if (!session || parts.length !== 2 || parts[0] !== session.id
          || !/^(index\.m3u8|segment-\d{6}\.ts)$/.test(filename)) {
        res.writeHead(404).end("Not found");
        return;
      }
      session.lastAccess = Date.now();
      const file = path.join(session.dir, filename);
      fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) return res.writeHead(404).end("Not found");
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "Content-Length": stat.size,
        });
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
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
    // ── 本地磁盘文件（仅 --local-fs，即 Electron 桌面端）──
    if (LOCAL_FS && urlPath === "/local-check") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Allow": "POST" }).end("Method not allowed");
        return;
      }
      let body;
      try {
        body = await readJson(req, 1024 * 1024);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 5000) : [];
      const results = {};
      for (const p of paths) {
        if (typeof p !== "string" || !p) continue;
        try {
          const st = fs.statSync(p);
          results[p] = { exists: st.isFile(), size: st.size };
        } catch {
          results[p] = { exists: false, size: 0 };
        }
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ results }));
      return;
    }
    if (LOCAL_FS && urlPath === "/local") {
      const target = new URL(req.url, "http://local").searchParams.get("path") || "";
      let stat;
      try {
        stat = fs.statSync(target);
        if (!stat.isFile()) throw new Error("not a file");
      } catch {
        res.writeHead(404).end("Not found");
        return;
      }
      const type = VIDEO_MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
      const base = {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      };
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = NaN;
        let end = stat.size - 1;
        if (m) {
          if (m[1]) {
            start = parseInt(m[1], 10);
            if (m[2]) end = Math.min(parseInt(m[2], 10), stat.size - 1);
          } else if (m[2]) {
            start = Math.max(0, stat.size - parseInt(m[2], 10));
          }
        }
        if (!Number.isFinite(start) || start > end || start >= stat.size) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
          return;
        }
        res.writeHead(206, {
          ...base,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": end - start + 1,
        });
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(target, { start, end }).on("error", () => res.destroy()).pipe(res);
      } else {
        res.writeHead(200, { ...base, "Content-Length": stat.size });
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(target).on("error", () => res.destroy()).pipe(res);
      }
      return;
    }
    if (urlPath === "/") urlPath = "/index.html";
    const file = path.resolve(__dirname, `.${urlPath}`);
    if (file !== __dirname && !file.startsWith(`${__dirname}${path.sep}`)) {
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
