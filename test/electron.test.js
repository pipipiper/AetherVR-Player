"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const { startServer } = require(path.join(__dirname, "..", "server.js"));

test("Windows desktop enables platform accelerated HEVC decoding", () => {
  assert.match(main, /enable-accelerated-video-decode/);
  assert.match(main, /PlatformHEVCDecoderSupport/);
  assert.match(main, /disable-direct-composition-video-overlays/);
});

test("desktop exposes read-only GPU diagnostics", () => {
  assert.match(main, /gpu:diagnostics/);
  assert.match(main, /getGPUFeatureStatus/);
  assert.match(preload, /gpuDiagnostics:.*gpu:diagnostics/);
});

test("desktop bundles hls.js and wires HLS transcode playback", () => {
  const hlsFile = path.join(__dirname, "..", "vendor", "hls.min.js");
  assert.equal(fs.existsSync(hlsFile), true);
  assert.match(html, /<script src="\.\/vendor\/hls\.min\.js"><\/script>/);
  assert.match(html, /window\.Hls\.isSupported\(\)/);
});

test("desktop SMB handles encoded credentials, spaced share names, mountpoint check, and GBK errors", () => {
  assert.match(main, /isMacMountPoint/);
  assert.match(main, /\$\{prefix\}_\$\{hash\}/);
  assert.match(main, /\/\^\(\.\+\?\)\\s\+\(Disk\|IPC\)\\b\//);
  assert.match(main, /runCommand\('net', args, 20000, 'gbk'\)/);
  assert.match(html, /smbMountRoots\s*=\s*new Map\(\)/);
});

test("desktop cleans up server on quit, configures file associations, and bridges storage/openFiles", () => {
  assert.match(main, /app\.on\('before-quit'/);
  assert.match(main, /serverHandle\?\.close\?\.\(\)/);
  assert.match(main, /app\.on\('open-file'/);
  assert.match(main, /storage:read/);
  assert.match(preload, /onOpenFiles:/);
  assert.match(preload, /readStorage:/);
  assert.equal(Array.isArray(pkg.build?.fileAssociations), true);
  assert.equal(pkg.build.fileAssociations.length >= 2, true);
});

test("server localFs supports /local probe target with token check and clean shutdown", async () => {
  const handle = await startServer({ host: "127.0.0.1", port: 0, localFs: true, localToken: "tok123" });
  try {
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const badRes = await fetch(`${baseUrl}/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ url: `${baseUrl}/local?path=${encodeURIComponent(__filename)}&token=wrong` }),
    });
    assert.equal(badRes.status, 400);
    const badJson = await badRes.json();
    assert.match(badJson.error, /Forbidden local target/);
  } finally {
    handle.close();
  }
});
