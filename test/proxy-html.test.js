"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

process.env.AETHERVR_TRUST_PRIVATE_SOURCES = "1";
const { startServer } = require("../server.js");

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("proxy never serves upstream HTML as a same-origin page", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><script>document.title='pwned'</script></html>");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const running = await startServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await new Promise((resolve) => running.server.close(resolve)); });

  const target = `http://127.0.0.1:${upstream.address().port}/x.html`;
  const response = await request(running.port, `/proxy?url=${encodeURIComponent(target)}`);
  assert.equal(response.status, 502);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.doesNotMatch(response.headers["content-type"] || "", /text\/html/i);
  assert.doesNotMatch(response.body, /<script/i);
});
