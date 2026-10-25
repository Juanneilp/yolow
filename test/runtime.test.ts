import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { assertSupportedRuntime } from "../src/runtime.ts";

test("runtime accepts patched Node 22 and rejects older, unsupported and prerelease runtimes", () => {
  for (const version of ["22.23.4", "22.23.5", "22.24.0"]) assert.doesNotThrow(() => assertSupportedRuntime(version));
  for (const version of ["20.20.0", "22.21.0", "22.23.2", "22.23.3", "24.22.1", "26.12.1", "22.23.4-rc.1", "unknown"]) {
    assert.throws(() => assertSupportedRuntime(version), /requires Node.js 22.23.4/);
  }
});

test("bn.js maskn(0) returns zero without hanging the SDK process", () => {
  const output = execFileSync(process.execPath, ["-e", 'const BN = require("bn.js"); process.stdout.write(new BN(1).maskn(0).toString(10));'],
    { encoding: "utf8", timeout: 3000 });
  assert.equal(output, "0");
});

test("body-parser survives trailing compressed bytes and serves another request", () => {
  execFileSync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require("node:assert/strict");
    const { createServer, request } = require("node:http");
    const { gzipSync } = require("node:zlib");
    const parse = require("body-parser").json();
    const server = createServer((req, res) => parse(req, res, (err) => {
      res.statusCode = err ? 400 : 200; res.end("ok");
    }));
    const send = (payload, encoding) => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.address().port, method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length,
          ...(encoding ? { "content-encoding": encoding } : {}) } }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject); req.end(payload);
    });
    server.listen(0, "127.0.0.1", async () => {
      try {
        const malformed = Buffer.concat([gzipSync('{}'), Buffer.from('trailing bytes')]);
        assert.ok([200, 400].includes(await send(malformed, "gzip")));
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(await send(Buffer.from('{}')), 200);
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { server.close(); }
    });
  `], { timeout: 5000, stdio: "pipe" });
});
