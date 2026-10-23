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
    "posterWallSources", "pwLoadSource", "pwSaveSource", "pwMergeScan",
    "pwSwitchSource", "pwScan", "pwRenderPicker", "pwRenderMovies",
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
