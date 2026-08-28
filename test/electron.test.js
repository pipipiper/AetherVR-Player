"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");

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
