"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

process.env.AETHERVR_TRUST_PRIVATE_SOURCES = "1";
const { startServer } = require("../server.js");

function request(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("trusted LAN mode allows any private source port", async (t) => {
  const running = await startServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await new Promise((resolve) => running.server.close(resolve)); });

  const body = JSON.stringify({ url: "http://127.0.0.1:9/video.mp4" });
  const response = await request(running.port, "/probe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Origin": `http://127.0.0.1:${running.port}`,
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body, /not allowed|private or reserved/i);
});
