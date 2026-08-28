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
