"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("executable inline scripts parse", () => {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc=/i.test(match[1]) && !/application\/ld\+json/i.test(match[1]));
  assert.ok(scripts.length > 0);
  scripts.forEach((match, index) => {
    assert.doesNotThrow(() => new vm.Script(match[2], { filename: `index-inline-${index}.js` }));
  });
});

test("diagnostics controls are present and uniquely identified", () => {
  for (const id of [
    "diagnosticsBtn", "diagnosticsPanel", "diagnosticsBody",
    "diagnosticsCopy", "diagnosticsClose",
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, id);
  }
});

test("global error dialog is present, unique, and wired to showError", () => {
  for (const id of [
    "appErrorMask", "appErrorTitle", "appErrorSummary",
    "appErrorDetails", "appErrorCopy", "appErrorClose",
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, id);
  }
  assert.match(html, /appErrorMask\.classList\.add\('active'\)/);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /source host and port are not allowed/);
});

test("desktop diagnostics report Electron GPU video decode status", () => {
  assert.match(html, /vrDesktop\.gpuDiagnostics\(\)/);
  assert.match(html, /status\.video_decode/);
});

test("core modules are defined exactly once (no accidental deletion or duplication)", () => {
  // 曾经在 v1.7.1 误删整段 WebDAV 模块，导致运行时报
  // "getWebdavServers is not defined"，这里做静态防回归。
  const required = [
    "getWebdavServers", "saveWebdavServers", "rememberWebdavServer",
    "renderWebdavRecents", "hostnameOfUrl", "loadSavedWebdavConfig",
    "fetchWebdavDirectory", "parseWebdavXml", "renderWebdavItems",
    "playWebdavFromQueue",
    "stripExt", "posterKindOf", "posterKeyOf", "buildPosterWall",
    "renderPosterWall",
    // 海报墙（对齐 iOS）：来源隔离 / 多文件夹增量 / 导出导入
    // 目录选择器已迁入右侧播放列表面板（pwRenderPickerPanel）
    "posterWallSources", "pwLoadSource", "pwSaveSource", "pwMergeScan",
    "pwSwitchSource", "pwScan", "pwRenderPickerPanel", "pwRenderMovies",
    "pwShowBackupMenu", "pwShowFolderManager",
  ];
  for (const name of required) {
    const defs = html.match(new RegExp(`function ${name}\\s*\\(`, "g")) || [];
    assert.equal(defs.length, 1, `${name} must be defined exactly once, got ${defs.length}`);
  }
});

test("no duplicated top-level const declarations in inline script", () => {
  // 重复 const 会让整个脚本块 SyntaxError 直接不执行，
  // 表现为满屏 "xxx is not defined"。
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((body) => !/application\/ld\+json/i.test(body));
  for (const body of scripts) {
    const seen = new Map();
    for (const match of body.matchAll(/^\s{8}const\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
      const name = match[1];
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    for (const [name, count] of seen) {
      assert.equal(count, 1, `const ${name} declared ${count} times in one script block`);
    }
  }
});

test("poster wall persists scan progress incrementally (not only on completion)", () => {
  // 用户反馈：扫描到一半退出会全部丢失。
  // 要求：增量渲染时就要落库，且退出路径要冲刷未落库进度。
  assert.match(html, /function pwPersistProgress/, "must have throttled persist");
  assert.match(html, /function pwFlushPersist/, "must have flush");
  assert.match(html, /pwPersistProgress\(list, rootPath\)/, "persist must run inside incremental emit");
  // 关键退出路径都要冲刷
  const flushCalls = (html.match(/pwFlushPersist\(\)/g) || []).length;
  assert.ok(flushCalls >= 4, `expected flushes on close/switch/abort/unload, got ${flushCalls}`);
  // 节流时间不超过 2s，否则丢失窗口太大
  const throttle = html.match(/pwPersistTimer = setTimeout\([\s\S]*?\},\s*(\d+)\)/);
  assert.ok(throttle, "throttle timeout must exist");
  assert.ok(Number(throttle[1]) <= 2000, `throttle ${throttle[1]}ms too long`);
});

test("poster wall keeps each source (incl. multiple WebDAV) fully separate", () => {
  // 每个来源独立 key：webdav|<serverId> / smb|<id>
  assert.match(html, /id: 'webdav\|' \+ \(s\.id \|\| s\.url\)/);
  assert.match(html, /id: 'smb\|' \+ \(s\.id \|\| s\.host\)/);
  // 每来源一个独立存储键
  assert.match(html, /const PW_STORE_PREFIX = 'aethervr-poster-source-v1\|'/);
  assert.match(html, /function pwStoreKey\(sourceId\) \{ return PW_STORE_PREFIX \+ sourceId; \}/);
  // 增量合并按 rootPath 替换，保留其它文件夹
  assert.match(html, /snap\.movies = \(snap\.movies \|\| \[\]\)\.filter\(\(m\) => m\.rootPath !== rootPath\)/);
});

test("poster wall supports incremental rescan without losing existing entries", () => {
  // 重扫同一文件夹时，新片插入、已有更新、漏读的标记失效而不是直接删
  assert.match(html, /function pwMergeScan\(sourceId, meta, rootPath, movies, options\)/);
  assert.match(html, /snapMovie\.missingSince = null/, "rescanned entries must clear missing flag");
  assert.match(html, /merged\.push\(\{ \.\.\.old, missingSince: old\.missingSince \|\| Date\.now\(\) \}\)/,
    "unseen entries must be marked, not deleted");
  // 中断的半成品扫描不应标记失效
  assert.match(html, /if \(complete\) \{/);
  // 有增量扫描入口
  assert.match(html, /'incremental'/, "scan must accept incremental mode");
  assert.match(html, /data-incremental/);
});

test("poster wall purges invalid (missing) entries on demand", () => {
  assert.match(html, /function pwPurgeMissing\(sourceId, olderThanMs\)/);
  assert.match(html, /function pwMissingList\(sourceId\)/);
  assert.match(html, /data-purge/, "purge button must exist in folder manager");
  // 统计失效数量并展示
  assert.match(html, /疑似失效/);
});

test("file drop → playback chain is intact", () => {
  // 拖入视频是核心功能，历史上曾因整段脚本被误删而失效。
  // 这里锁定从 drop 到播放的完整调用链。
  const chain = [
    "handleFiles", "addToFilePool", "buildTempItems", "ensureTempTab",
    "setPlaylist", "renderPlaylist", "playAt", "playResolved",
    "loadVideoFile", "loadVideoURL", "isPlayable",
  ];
  for (const fn of chain) {
    const defs = html.match(new RegExp(`function ${fn}\\s*\\(`, "g")) || [];
    assert.equal(defs.length, 1, `${fn} must be defined exactly once, got ${defs.length}`);
  }
  // 拖放监听必须存在，且 dropZone 要阻止冒泡避免重复处理
  assert.match(html, /dropZone\.addEventListener\('drop'/, "dropZone drop handler missing");
  assert.match(html, /document\.addEventListener\('drop'/, "document-level drop fallback missing");
  assert.match(html, /e\.stopPropagation\(\);\s*\/\/ 阻止冒泡到 document 级兜底/);
  // 存在 file 时必须有兜底播放路径（pathForFile 失败也不至于无法播放）
  assert.match(html, /if \(item\.file\) \{\s*\n\s*loadVideoFile\(item\.file\)/);
});

test("player controls expose a stop button and a usable progress bar", () => {
  // 停止按钮必须存在且绑定逻辑
  assert.match(html, /id="stopBtn"/, "stop button markup missing");
  assert.match(html, /function stopPlayback\(\)/, "stopPlayback must exist");
  assert.match(html, /stopBtn\.addEventListener\('click'/, "stop button must be wired");
  // 进度条不能太细：轨道高度 ≥ 10px
  const pb = html.match(/\.progress-bar\s*\{[^}]*height:\s*(\d+)px/);
  assert.ok(pb, "progress bar height must be declared");
  assert.ok(Number(pb[1]) >= 10, `progress bar too thin: ${pb[1]}px`);
  // 控制栏分两行：进度条独占一行，按钮分列两侧
  assert.match(html, /class="controls-progress-row"/);
  assert.match(html, /class="controls-main-row"/);
  assert.match(html, /class="controls-side right"/);
});

test("new-file panel can always be closed (regression)", () => {
  // 曾经用 videoPlayer.src 判断是否显示关闭按钮，
  // blob:/ 或尚未赋值时为空串 → 关闭按钮被隐藏，面板再也退不出去。
  assert.match(html, /const hasSource = Boolean\(/);
  assert.match(html, /heroClose\.style\.display = hasSource/);
  assert.match(html, /heroClose\.addEventListener\('click'/, "close handler must exist");
});

test("error state hides the video surface and uses a dark card", () => {
  assert.match(html, /function setVideoSurfaceVisible\(visible\)/);
  assert.match(html, /setVideoSurfaceVisible\(false\)/, "must hide video on error");
  assert.match(html, /setVideoSurfaceVisible\(true\)/, "must restore video on success");
  // 报错卡片不再是刺眼红框
  assert.doesNotMatch(html, /box-shadow: 3px 3px 0 var\(--red\)/);
});

test("webdav/SMB list rows mirror the playlist row style", () => {
  // 与 .playlist-item 对齐：8px/10px padding、8px 圆角、12.5px 字号
  const row = html.match(/\.webdav-item\s*\{[^}]*\}/);
  assert.ok(row, "webdav-item style missing");
  assert.match(row[0], /padding:\s*8px 10px/);
  assert.match(row[0], /border-radius:\s*8px/);
  assert.match(row[0], /font-size:\s*12\.5px/);
  // 深色 hover 与播放列表一致
  assert.match(html, /\.webdav-item:hover \{ background: rgba\(255,255,255,\.08\); \}/);
});

test("SMB is desktop-only and bridged through preload", () => {
  assert.match(html, /window\.vrDesktop\.smbListShares/);
  assert.match(html, /window\.vrDesktop\.smbListDir/);
  assert.match(html, /SMB 仅在桌面端可用/);
});

test("cloud browser is embedded directly into the playlist panel", () => {
  // 云端文件列表直接嵌入播放列表面板，不再是独立浮层
  assert.doesNotMatch(html, /id="cloudBrowserPanel"/);
  // 条目样式与播放列表一致
  assert.match(html, /playlist-item cb-item/);
  // 连接信息在独立弹层中，面板内只展示纯净列表
  assert.match(html, /id="connectSourceModalMask"/);
  assert.match(html, /id="cloudSourceSelect"/);
  assert.match(html, /id="cloudBrowserFileList"/);
  assert.match(html, /id="cloudBrowserPathBar"/);
  // 云端工具行 / 路径栏 / 文件列表都在播放列表面板内
  const panel = html.match(
    /<div class="playlist-panel" id="playlistPanel">[\s\S]*?<div class="playlist-foot">/);
  assert.ok(panel, "playlist panel markup missing");
  assert.match(panel[0], /id="cloudBar"/);
  assert.match(panel[0], /id="cloudBrowserPathBar"/);
  assert.match(panel[0], /id="cloudBrowserFileList"/);
  // 面板顶部是「播放列表 / 云端」并列的顶级页签
  assert.match(panel[0], /id="panelTabPlaylist"/);
  assert.match(panel[0], /id="panelTabCloud"/);
  // 子页签行（收藏夹 + 各播放列表）在云端模式下隐藏
  assert.match(panel[0], /id="playlistSubHead"/);
});

test("WebDAV playback automatically resolves credentials to prevent 401 decode errors", () => {
  assert.match(html, /function findMatchingWebdavAuth/);
  assert.match(html, /cred = btoa\(unescape\(encodeURIComponent\(rawCred\)\)\)/);
  assert.match(html, /&cred=/);
});
