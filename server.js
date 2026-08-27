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
  // 值以 '-' 开头说明是下一个开关（如 `--port --local-fs`），不能当作参数值
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  return fallback;
}

/* 运行配置：由 startServer() 设置（CLI 在文件底部解析 argv 后调用）。
 * --local-fs（仅 Electron 桌面端传入）：开放 /local 接口，
 * 允许页面按绝对路径流式读取本机磁盘文件（带 Range，可拖动进度）。
 * 网页部署时绝不带此开关。 */
let HOST = "127.0.0.1";
let PORT = 7100;
let LOCAL_FS = false;
// /local 接口的访问令牌：--local-fs 下必校验，未显式传入时启动时随机生成
let LOCAL_TOKEN = "";
// 仅 --trust-proxy 时才信任 X-Forwarded-For（限流/会话归属按客户端 IP）
let TRUST_PROXY = false;
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

// 只公开播放器运行所需的静态资源。绝不能把整个源码目录当作 Web 根目录，
// 否则从 Git checkout 启动时会暴露 .git/config、.env、服务端源码等文件。
const PUBLIC_EXACT_PATHS = new Set(["/index.html", "/favicon.svg", "/background-pic.jpg"]);
const REAL_PUBLIC_ROOT = fs.realpathSync(__dirname);
const REAL_VENDOR_ROOT = path.join(REAL_PUBLIC_ROOT, "vendor");

function publicFilePath(urlPath) {
  const webPath = urlPath.replace(/\\/g, "/");
  if (!PUBLIC_EXACT_PATHS.has(webPath) && !webPath.startsWith("/vendor/")) return null;
  const candidate = path.resolve(__dirname, `.${webPath}`);
  if (webPath.startsWith("/vendor/")
      && candidate !== path.join(__dirname, "vendor")
      && !candidate.startsWith(`${path.join(__dirname, "vendor")}${path.sep}`)) return null;
  return candidate;
}

/* ── HLS 实时转码 ─────────────────────────────────────────────
 * 手机硬解不了 8K HEVC 时，由本机 ffmpeg 实时转成 4K H.264 HLS，
 * iPhone Safari 原生支持 HLS 播放与进度拖动。
 * 同时只保留一个转码会话（本机单用户场景）。 */
const { spawn, spawnSync } = require("child_process");
const os = require("os");

// 每个进程使用独立目录，避免多个实例互相删除 HLS 分片。
const HLS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "aethervr-hls-"));

function findOnPath(command) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const hasExtension = Boolean(path.extname(command));
  const extensions = process.platform === "win32" && !hasExtension
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      const alternatives = ext && ext !== ext.toLowerCase() ? [candidate, path.join(dir, command + ext)] : [candidate];
      for (const file of alternatives) {
        try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* 继续查找 */ }
      }
    }
  }
  return null;
}

function resolveExecutable(configured, command, commonPaths) {
  if (configured) {
    if (path.isAbsolute(configured) || configured.includes(path.sep)) return configured;
    return findOnPath(configured) || configured;
  }
  return commonPaths.find((file) => fs.existsSync(file)) || findOnPath(command) || command;
}

const FFMPEG = resolveExecutable(process.env.FFMPEG, "ffmpeg", [
  "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg",
]);
const FFPROBE = resolveExecutable(process.env.FFPROBE, "ffprobe", [
  "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe",
]);
const FFMPEG_AVAILABLE = path.isAbsolute(FFMPEG) && fs.existsSync(FFMPEG);
const FFPROBE_AVAILABLE = path.isAbsolute(FFPROBE) && fs.existsSync(FFPROBE);

let ffmpegEncoders = null;
function ffmpegHasEncoder(name) {
  if (!FFMPEG_AVAILABLE) return false;
  if (ffmpegEncoders === null) {
    const result = spawnSync(FFMPEG, ["-hide_banner", "-encoders"], {
      encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    ffmpegEncoders = !result.error && result.status === 0 ? (result.stdout || "") : "";
  }
  return new RegExp(`\\b${name}\\b`).test(ffmpegEncoders);
}

const requestedEncoder = (process.env.AETHERVR_VIDEO_ENCODER || "auto").toLowerCase();
const supportedEncoderChoices = new Set(["auto", "libx264", "h264_videotoolbox", "h264_vaapi"]);
if (!supportedEncoderChoices.has(requestedEncoder)) {
  console.warn(`Unknown AETHERVR_VIDEO_ENCODER=${requestedEncoder}; falling back to auto`);
}
const encoderChoice = supportedEncoderChoices.has(requestedEncoder) ? requestedEncoder : "auto";
const VIDEO_ENCODER_NAME = encoderChoice === "auto"
  ? (process.platform === "darwin" && ffmpegHasEncoder("h264_videotoolbox") ? "h264_videotoolbox" : "libx264")
  : encoderChoice;
const VAAPI_DEVICE = process.env.AETHERVR_VAAPI_DEVICE || "/dev/dri/renderD128";
const USE_VAAPI = VIDEO_ENCODER_NAME === "h264_vaapi";
let vaapiDeviceAvailable = !USE_VAAPI;
if (USE_VAAPI) {
  try {
    fs.accessSync(VAAPI_DEVICE, fs.constants.R_OK | fs.constants.W_OK);
    vaapiDeviceAvailable = true;
  } catch { vaapiDeviceAvailable = false; }
}
const VIDEO_ENCODER_AVAILABLE = ffmpegHasEncoder(VIDEO_ENCODER_NAME) && vaapiDeviceAvailable;
const configuredThreads = Number(process.env.AETHERVR_TRANSCODE_THREADS || "");
const TRANSCODE_THREADS = Number.isInteger(configuredThreads) && configuredThreads > 0 && configuredThreads <= 256
  ? String(configuredThreads) : null;
const VIDEO_INPUT_ACCEL = USE_VAAPI
  ? ["-hwaccel", "vaapi", "-hwaccel_device", VAAPI_DEVICE, "-hwaccel_output_format", "vaapi"]
  : [];
const VIDEO_FILTER = USE_VAAPI
  ? "scale_vaapi=w='min(3840,iw)':h=-2:format=nv12"
  : "scale=w='min(3840,iw)':h=-2:flags=bicubic,format=yuv420p";
const VIDEO_PIXEL_FORMAT = USE_VAAPI ? [] : ["-pix_fmt", "yuv420p"];
const VIDEO_ENCODER = VIDEO_ENCODER_NAME === "h264_videotoolbox"
  ? ["-c:v", "h264_videotoolbox", "-b:v", "12M"]
  : USE_VAAPI
    ? ["-c:v", "h264_vaapi", "-profile:v", "high", "-level:v", "5.2",
        "-rc_mode", "CBR", "-b:v", "12M", "-maxrate", "12M", "-bufsize", "24M", "-bf", "0"]
    : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "21",
        ...(TRANSCODE_THREADS ? ["-threads", TRANSCODE_THREADS] : [])];

const HLS_IDLE_MS = 2 * 60 * 1000;
const HLS_MAX_MS = 2 * 60 * 60 * 1000;
// 冷却只防恶意刷接口：快进重启转码也走 /transcode，不能定得太长
const TRANSCODE_COOLDOWN_MS = 4 * 1000;
const PROBE_COOLDOWN_MS = 2 * 1000;
const transcodeStarts = new Map();
const probeStarts = new Map();
// 限流 Map 按 IP 累积、只增不减：每次写入前顺带清理 10 分钟前的旧条目
function sweepStaleEntries(map) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, ts] of map) if (ts < cutoff) map.delete(key);
}
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

const hlsCleanupTimer = setInterval(() => {
  if (!hlsSession) return;
  const now = Date.now();
  if (now - hlsSession.lastAccess > HLS_IDLE_MS || now - hlsSession.startedAt > HLS_MAX_MS) {
    stopHlsSession(hlsSession);
  }
}, 30000);
hlsCleanupTimer.unref?.();

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
    ...VIDEO_INPUT_ACCEL,
    "-i", proxyInput,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...VIDEO_ENCODER,
    "-vf", VIDEO_FILTER,
    ...VIDEO_PIXEL_FORMAT,
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
    session.error = (session.error + text).slice(-16384);
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
    if (res.writableEnded) {
      clearInterval(session.startTimer);
      session.startTimer = null;
      return;
    }
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
        const diagnostic = session.error
          .split(/\r?\n/)
          .filter((line) => !line.includes("/proxy?url="))
          .filter((line) => /(error|failed|invalid|unsupported|vaapi|encoder|device|conversion)/i.test(line))
          .slice(-12)
          .join("\n")
          .slice(-1800);
        stopHlsSession(session);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "转码启动失败：" + (diagnostic || session.error.slice(-1000)) }));
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
process.on("exit", () => {
  stopHlsSession();
  try { fs.rmSync(HLS_ROOT, { recursive: true, force: true }); } catch {}
});

/* Same-origin video proxy: forwards Range headers, follows redirects.
 * Lets the player use remote URLs as WebGL textures (VR mode) even when
 * the remote server sends no CORS headers. */
function isBlockedAddress(address) {
  const value = address.toLowerCase().split("%")[0];
  // 十六进制 IPv4-mapped IPv6（::ffff:7f00:1 ≡ 127.0.0.1）：先归一化为点分 IPv4 再递归
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
  if (mappedHex) {
    const n = (parseInt(mappedHex[1], 16) << 16) | parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
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
      || value.startsWith("2001:db8:")
      || value.startsWith("64:ff9b:1:");
  }
  return true;
}

// --local-fs（Electron 桌面端）同时放开内网/非标端口限制：
// 桌面端常用于播放局域网 OpenList / NAS / SMB 转链，SSRF 防护只针对公网部署。
let RELAX_LOCAL = false;

// 非标端口例外（逗号分隔的 host:port）：AETHERVR_ALLOWED_HOSTPORT=host1:port1,host2:port2
const ALLOWED_HOSTPORTS = (process.env.AETHERVR_ALLOWED_HOSTPORT || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

async function resolveSafeTarget(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error("Only http(s) URLs allowed");
  if (u.username || u.password) throw new Error("Credentials in URLs are not allowed");
  if (!RELAX_LOCAL) {
    const allowedHostPort = ALLOWED_HOSTPORTS.includes(`${u.hostname.toLowerCase()}:${u.port}`);
    if (u.port && !['80', '443'].includes(u.port) && !allowedHostPort) {
      throw new Error("This source host and port are not allowed");
    }
    const addresses = await dns.lookup(u.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address))) {
      throw new Error("Private or reserved network targets are not allowed");
    }
    return addresses[0];
  }
  // 桌面端（--local-fs）：仅校验协议，直连内网任意地址/端口
  const addresses = await dns.lookup(u.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Cannot resolve host");
  return addresses[0];
}

/* 远程链接预检：只取前 2KB（Range），判断上游返回的是不是视频数据。
 * OpenList/网盘路径错误、签名过期、权限不足时返回的是 JSON/HTML，
 * 直接交给播放器只会得到误导性的「无法解码」。 */
function preflightRemote(target, redirects = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch { return resolve({ error: "链接格式不正确" }); }
    resolveSafeTarget(u).then((resolved) => {
      const lib = u.protocol === "https:" ? https : http;
      const options = {
        protocol: u.protocol,
        hostname: resolved.address,
        family: resolved.family,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: {
          "Host": u.host,
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
          "Range": "bytes=0-2047",
        },
        timeout: 10000,
      };
      if (u.protocol === "https:" && !net.isIP(u.hostname)) options.servername = u.hostname;
      const preq = lib.get(options, (pres) => {
        if ([301, 302, 303, 307, 308].includes(pres.statusCode) && pres.headers.location) {
          pres.resume();
          if (redirects >= 5) return resolve({ error: "重定向次数过多" });
          return resolve(preflightRemote(new URL(pres.headers.location, u).href, redirects + 1));
        }
        const ct = (pres.headers["content-type"] || "").toLowerCase();
        const status = pres.statusCode;
        if (status >= 400 || /json|html|text|xml/.test(ct)) {
          let snippet = "";
          pres.on("data", (d) => {
            if (snippet.length < 300) snippet += d.toString("utf8");
            if (snippet.length >= 300) pres.destroy();
          });
          pres.on("close", () => {
            const detail = snippet.replace(/\s+/g, " ").trim().slice(0, 200);
            resolve({
              error: `上游返回 HTTP ${status}（内容类型 ${ct || "未知"}），不是视频数据。`
                + (detail ? `上游消息：${detail}` : "")
                + "（常见原因：路径错误、签名过期、权限不足）",
            });
          });
          pres.resume();
          return;
        }
        pres.destroy();
        resolve({ ok: true });
      });
      preq.on("timeout", () => { preq.destroy(); resolve({ error: "连接上游超时（10 秒无响应）" }); });
      preq.on("error", (e) => resolve({ error: "无法连接上游：" + e.message }));
    }).catch((e) => resolve({ error: e.message }));
  });
}

async function proxyVideo(target, req, res, redirects = 0) {  let u;
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
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
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

const requestHandler = async (req, res) => {
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
      if (!VIDEO_ENCODER_AVAILABLE) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `ffmpeg encoder ${VIDEO_ENCODER_NAME} is not available` }));
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
      sweepStaleEntries(transcodeStarts);
      transcodeStarts.set(ip, Date.now());
      startTranscode(target, ip, res, start);
      return;
    }
    if (urlPath === "/api/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        app: "aethervr",
        backend: true,
        proxy: true,
        probe: FFPROBE_AVAILABLE,
        transcode: VIDEO_ENCODER_AVAILABLE,
      }));
      return;
    }
    if (urlPath === "/transcode/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ffmpeg: FFMPEG_AVAILABLE,
        ffprobe: FFPROBE_AVAILABLE,
        transcode: VIDEO_ENCODER_AVAILABLE,
        active: Boolean(hlsSession),
        ready: Boolean(hlsSession && hlsSession.ready),
        encoder: VIDEO_ENCODER_NAME,
        hardware: USE_VAAPI || VIDEO_ENCODER_NAME === "h264_videotoolbox",
        device: USE_VAAPI ? VAAPI_DEVICE : null,
      }));
      return;
    }
    if (urlPath === "/probe") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Allow": "POST" }).end("Method not allowed");
        return;
      }
      if (!FFPROBE_AVAILABLE) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "ffprobe is not available" }));
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
      sweepStaleEntries(probeStarts);
      probeStarts.set(ip, Date.now());
      // 先预检上游返回的是不是视频（OpenList 路径错误/签名过期会返回 JSON/HTML），
      // 不是视频时直接给出具体原因，而不是让 ffprobe/播放器报误导性错误
      preflightRemote(target).then((pf) => {
        if (pf && pf.error) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ preflight_error: pf.error }));
          return;
        }
        probeRemoteMedia(target, res);
      });
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
    // ── 本地磁盘文件（仅 --local-fs，即 Electron 桌面端；需携带访问令牌）──
    if (LOCAL_FS && urlPath === "/local") {
      const sp = new URL(req.url, "http://local").searchParams;
      if (sp.get("token") !== LOCAL_TOKEN) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const target = sp.get("path") || "";
      let stat;
      try {
        stat = await fs.promises.stat(target);
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
    const file = publicFilePath(urlPath);
    if (!file) {
      res.writeHead(404).end("Not found");
      return;
    }
    fs.realpath(file, (realPathError, realFile) => {
      const insidePublicRoot = !realPathError
        && realFile.startsWith(`${REAL_PUBLIC_ROOT}${path.sep}`)
        && (!urlPath.startsWith("/vendor/") || realFile.startsWith(`${REAL_VENDOR_ROOT}${path.sep}`));
      if (!insidePublicRoot) {
        res.writeHead(404).end("Not found");
        return;
      }
      fs.readFile(realFile, (err, data) => {
        if (err) {
          res.writeHead(404).end("Not found");
          return;
        }
        // 桌面端：把 /local 访问令牌注入 index.html 的 "__LOCAL_TOKEN__" 占位符
        // （只替换带引号的字面量，保留 window.__LOCAL_TOKEN__ 变量名本身）
        if (LOCAL_FS && urlPath === "/index.html") {
          data = Buffer.from(data.toString("utf8").split('"__LOCAL_TOKEN__"').join(JSON.stringify(LOCAL_TOKEN)));
        }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(realFile).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        if (req.method === "HEAD") return res.end();
        res.end(data);
      });
    });
  };

function isLoopbackHost(host) {
  if (host === "localhost" || host === "::1") return true;
  return net.isIP(host) === 4 && host.split(".")[0] === "127";
}

/* 启动 HTTP 服务。resolve { server, host, port, localToken, ipv6Server? }；
 * listen 失败（如端口被占）时 reject，由调用方决定报错还是换端口重试。 */
function startServer({ host = "127.0.0.1", port = 7100, localFs = false, localToken = "", trustProxy = false } = {}) {
  return new Promise((resolve, reject) => {
    HOST = host;
    PORT = port;
    LOCAL_FS = localFs;
    LOCAL_TOKEN = localToken;
    TRUST_PROXY = trustProxy;
    RELAX_LOCAL = LOCAL_FS;
    if (LOCAL_FS && !LOCAL_TOKEN) LOCAL_TOKEN = crypto.randomBytes(16).toString("hex");

    const server = http.createServer(requestHandler);
    server.once("error", reject);

    const done = (ipv6Server = null) => {
      const actualPort = server.address().port;
      PORT = actualPort;
      resolve({ server, host: HOST, port: actualPort, localToken: LOCAL_TOKEN, ipv6Server });
    };

    // "localhost" may resolve to ::1 only. Never bind the unspecified address
    // (all interfaces) here: listen on both loopbacks instead, sharing one handler.
    if (HOST === "localhost" || HOST === "::1") {
      server.listen(PORT, "127.0.0.1", () => {
        const actualPort = server.address().port;
        const ipv6Server = http.createServer(requestHandler);
        // 部分系统禁用了 IPv6。此时不能一直等待 ::1 的 listen 回调：
        // IPv4 loopback 已经可用，直接完成启动即可。
        ipv6Server.once("error", (err) => {
          console.warn(`IPv6 loopback unavailable (${err.code || err.message}); continuing on 127.0.0.1 only`);
          done();
        });
        ipv6Server.listen(actualPort, "::1", () => {
          console.log(`VR Player running at http://localhost:${actualPort}/ (loopback only: 127.0.0.1 & ::1)`);
          done(ipv6Server);
        });
      });
    } else {
      if (LOCAL_FS && !isLoopbackHost(HOST)) {
        console.warn("⚠️  WARNING: --local-fs is active on a non-loopback host — " +
          "the token-protected /local endpoint is reachable from the network. " +
          "Do NOT expose this server to untrusted networks.");
      }
      server.listen(PORT, HOST, () => {
        console.log(`VR Player running at http://${HOST}:${server.address().port}/`);
        done();
      });
    }
  });
}

module.exports = { startServer };

if (require.main === module) {
  const cliHost = arg("host", "127.0.0.1");
  const cliPort = Number(arg("port", 7100));
  if (!Number.isInteger(cliPort) || cliPort < 1 || cliPort > 65535) {
    console.error(`Error: --port must be an integer between 1 and 65535 (got "${arg("port", "")}")`);
    process.exit(1);
  }
  startServer({
    host: cliHost,
    port: cliPort,
    localFs: args.includes("--local-fs"),
    localToken: arg("local-token", ""),
    trustProxy: args.includes("--trust-proxy"),
  }).catch((err) => {
    console.error(`Server failed to start on ${cliHost}:${cliPort}: ${err.message}`);
    process.exit(1);
  });
}
