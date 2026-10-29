import assert from "node:assert/strict";
import { fetchWithRetry } from "../desktop/koios-retry.mjs";

{
  const responses = Array.from({ length: 5 }, () => new Response("rate limited", {
    status: 429, headers: { "retry-after": "2" },
  }));
  const waits = [];
  let attempt = 0;
  const result = await fetchWithRetry("https://example.test", {}, () => responses[attempt++],
    (response) => response.text(), (ms) => { waits.push(ms); });
  assert.equal(result, responses[4]);
  assert.equal(attempt, 5);
  assert.deepEqual(waits, [2_000, 2_000, 3_000, 6_000]);
  assert.equal(responses.slice(0, 4).every((response) => response.bodyUsed), true);
  assert.equal(result.bodyUsed, false, "the final Koios error body must remain readable by the caller");
  assert.equal(await result.text(), "rate limited");
}

{
  let attempt = 0;
  const result = await fetchWithRetry("https://example.test", {}, () => {
    if (!attempt++) throw new Error("transient network failure");
    return new Response("ok", { status: 200 });
  }, () => { throw new Error("successful responses must not be drained"); }, () => {});
  assert.equal(attempt, 2);
  assert.equal(await result.text(), "ok");
}

{
  let attempt = 0;
  const result = await fetchWithRetry("https://example.test", {}, () => {
    attempt++;
    return new Response("invalid request", { status: 400 });
  }, () => { throw new Error("a client error must not be retried"); }, () => {});
  assert.equal(attempt, 1);
  assert.equal(await result.text(), "invalid request");
}

{
  let calls = 0;
  const result = await fetchWithRetry("https://example.test/api/v1/submittx", {}, () => {
    calls++; return new Response("uncertain", { status: 503 });
  }, () => { throw new Error("submission must not be drained or retried"); }, () => {});
  assert.equal(calls, 1);
  assert.equal(await result.text(), "uncertain");
}
console.log("Koios retry checks passed.");
