import assert from "node:assert/strict";
import { blockfrostTarget, proxyBlockfrost } from "../desktop/blockfrost-proxy.mjs";
const base = "/blockfrost-mainnet/api/v0";
assert.equal(blockfrostTarget(`${base}/blocks/latest`, "GET"), "https://cardano-mainnet.blockfrost.io/api/v0/blocks/latest");
for (const path of ["/https://evil.test", "/blocks/latest?url=https://evil.test", "/blocks/%2e%2e/latest", "/accounts/stake1q/registrations?page=1&page=2", "/addresses/addr1q/utxos?count=101", "/blocks/latest?count=1"]) {
  assert.throws(() => blockfrostTarget(base + path, "GET"));
}
assert.throws(() => blockfrostTarget(base + "/blocks/latest", "POST"));
let calls = 0;
const fetcher = async (url, init) => { calls++; assert.equal(init.redirect, "error"); assert.deepEqual(Object.keys(init.headers), ["project_id"]); return new Response("{}", { status: 200 }); };
assert.equal((await proxyBlockfrost(base + "/blocks/latest", "GET", "a".repeat(32), null, null, fetcher)).status, 200);
assert.equal((await proxyBlockfrost(base + "/blocks/latest", "GET", "bad\r\nkey", null, null, fetcher)).status, 400);
assert.equal(calls, 1);
const oversized = await proxyBlockfrost(base + "/blocks/latest", "GET", "a".repeat(32), null, null,
  async () => new Response(new Uint8Array(12 * 1024 * 1024 + 1)));
assert.equal(oversized.status, 502);
console.log("Blockfrost proxy allowlist checks passed.");
