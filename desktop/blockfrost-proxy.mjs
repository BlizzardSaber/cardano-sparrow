const MAX_RESPONSE = 12 * 1024 * 1024;
const PATH = /^(?:\/blocks\/latest|\/epochs\/latest\/parameters|\/addresses\/addr(?:_test)?1[023456789acdefghjklmnpqrstuvwxyz]+(?:\/(?:utxos|transactions))?|\/txs\/[0-9a-f]{64}(?:\/utxos)?|\/accounts\/stake(?:_test)?1[023456789acdefghjklmnpqrstuvwxyz]+(?:\/registrations)?|\/assets\/[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}|\/pools\/pool1[023456789acdefghjklmnpqrstuvwxyz]+(?:\/metadata)?)$/;
export function blockfrostTarget(path, method) {
  const match = /^\/blockfrost-(mainnet|preprod)\/api\/v0(\/[^?#]*)(\?[^#]*)?$/.exec(path);
  if (!match || path.length > 1024) throw new Error("Invalid Blockfrost route");
  const [, network, route, query = ""] = match;
  if (method === "POST") {
    if (route !== "/tx/submit" || query) throw new Error("Invalid Blockfrost method");
  } else if (method !== "GET" || !PATH.test(route)) throw new Error("Invalid Blockfrost route");
  const params = new URLSearchParams(query);
  const seen = new Set();
  for (const [key, value] of params) {
    if (seen.has(key) || !["count", "page", "order"].includes(key)) throw new Error("Invalid Blockfrost query");
    seen.add(key);
    if ((key === "count" && (!/^\d{1,3}$/.test(value) || +value < 1 || +value > 100)) ||
        (key === "page" && (!/^\d{1,3}$/.test(value) || +value < 1 || +value > 500)) ||
        (key === "order" && value !== "asc" && value !== "desc")) throw new Error("Invalid Blockfrost query");
  }
  if (query && !/\/(utxos|transactions|registrations)$/.test(route)) throw new Error("Invalid Blockfrost query");
  return `https://cardano-${network}.blockfrost.io/api/v0${route}${query}`;
}
export async function proxyBlockfrost(path, method, key, contentType, body, fetchRequest) {
  let target;
  try { target = blockfrostTarget(path, method); } catch { return new Response("Invalid Blockfrost request", { status: 400 }); }
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) return new Response("Invalid Project ID", { status: 400 });
  if (method === "POST" && (contentType?.split(";", 1)[0] !== "application/cbor" || !body || body.byteLength > 2 * 1024 * 1024))
    return new Response("Invalid Blockfrost body", { status: 400 });
  try {
    const headers = { project_id: key, ...(method === "POST" ? { "Content-Type": "application/cbor" } : {}) };
    const result = await fetchRequest(target, { method, headers, body: method === "POST" ? body : undefined,
      redirect: "error", signal: AbortSignal.timeout(20_000) });
    const reader = result.body?.getReader(); const chunks = []; let size = 0;
    if (reader) {
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); return new Response("Blockfrost response too large", { status: 502 }); } chunks.push(value); }
      } finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(bytes, { status: result.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch { return new Response("Blockfrost upstream unavailable", { status: 502 }); }
}
