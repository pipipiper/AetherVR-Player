"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

delete process.env.AETHERVR_ALLOWED_HOSTPORT;
const { startServer } = require("../server.js");

function request(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("server exposes only public assets and generic capabilities", async (t) => {
  const running = await startServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await new Promise((resolve) => running.server.close(resolve)); });

  for (const pathname of ["/", "/index.html", "/favicon.svg", "/vendor/three.min.js"]) {
    const response = await request(running.port, pathname);
    assert.equal(response.status, 200, `${pathname} should be public`);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }

  for (const pathname of ["/.git/config", "/.env", "/package.json", "/server.js", "/electron/main.cjs"]) {
    const response = await request(running.port, pathname);
    assert.equal(response.status, 404, `${pathname} must not be public`);
  }

  const capabilities = await request(running.port, "/api/capabilities");
  assert.equal(capabilities.status, 200);
  const parsed = JSON.parse(capabilities.body);
  assert.equal(parsed.app, "aethervr");
  assert.equal(parsed.backend, true);

  const status = await request(running.port, "/transcode/status");
  assert.equal(status.status, 200);
  const statusBody = JSON.parse(status.body);
  assert.deepEqual(statusBody.hls, {
    mode: "rolling",
    segmentSeconds: 4,
    listSize: 30,
    windowSeconds: 120,
  });

  const stopOrigin = `http://127.0.0.1:${running.port}`;
  const stop = await request(running.port, "/transcode/stop", {
    method: "POST",
    headers: { Origin: stopOrigin },
  });
  assert.equal(stop.status, 204);

  const crossOriginStop = await request(running.port, "/transcode/stop", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(crossOriginStop.status, 403);

  const getStop = await request(running.port, "/transcode/stop");
  assert.equal(getStop.status, 405);

  const source = JSON.stringify({ url: "https://example.com:8443/video.mp4" });
  const blockedPort = await request(running.port, "/probe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(source),
      "Origin": `http://127.0.0.1:${running.port}`,
    },
    body: source,
  });
  assert.equal(blockedPort.status, 400);
  assert.match(blockedPort.body, /source host and port are not allowed/i);
});
