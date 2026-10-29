import { defineConfig, loadEnv, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { proxyBlockfrost } from "./desktop/blockfrost-proxy.mjs";

const targets = {
  "/koios-mainnet": "https://api.koios.rest",
  "/koios-preprod": "https://preprod.koios.rest",
} as const;

const LOCAL_HOSTS = new Set(["localhost:4173", "127.0.0.1:4173", "[::1]:4173"]);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;
const ICON_ROUTE = "/asset-icon";
const PRICE_ROUTE = "/market-prices";
const QUOTE_ROUTE = "/asset-quotes";
const USDCX_QUOTE_ROUTE = "/usdcx-quote";
const USDCX_ASSET_ID = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378";
const PRICE_URLS = {
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=cardano,midnight-3&vs_currencies=usd,cny&include_last_updated_at=true",
  okx: "https://www.okx.com/api/v5/market/ticker?instId=ADA-USDT",
} as const;
const ICON_MAX_BYTES = 512 * 1024;
const ICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ICON_CACHE_ENTRIES = 128;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const ALLOWED_ICON_HOSTS = new Set(["ipfs.io", "dweb.link", "gateway.pinata.cloud", "arweave.net"]);
const allowedRoutes = new Map([
  ["/api/v1/cli_protocol_params", "GET"],
  ["/api/v1/tip", "GET"],
  ["/api/v1/address_utxos", "POST"],
  ["/api/v1/address_outputs", "POST"],
  ["/api/v1/address_info", "POST"],
  ["/api/v1/address_txs", "POST"],
  ["/api/v1/tx_info", "POST"],
  ["/api/v1/asset_info", "POST"],
  ["/api/v1/account_info", "POST"],
  ["/api/v1/pool_info", "POST"],
  ["/api/v1/submittx", "POST"],
] as const);
const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), hid=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

type CachedResponse = { status: number; contentType: string | null; contentRange: string | null; body: Uint8Array; expiresAt: number };
const responseCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, Promise<CachedResponse>>();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    optimizeDeps: { exclude: ["@emurgo/cardano-serialization-lib-browser"] },
    plugins: [koiosProxy(env.KOIOS_API_TOKEN)],
    server: localServerOptions(),
    preview: localServerOptions(),
  };
});

function localServerOptions() {
  return {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["localhost"],
    headers: securityHeaders,
  };
}

function koiosProxy(apiToken?: string): Plugin {
  const install = (middlewares: { use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void }) => {
    middlewares.use((req, res, next) => {
      const pathname = (req.url ?? "").split("?", 1)[0];
      if (pathname.startsWith("/blockfrost-")) {
        void forwardBlockfrost(req, res);
        return;
      }
      if (pathname === ICON_ROUTE) {
        void forwardIcon(req, res);
        return;
      }
      if (pathname === PRICE_ROUTE) {
        void forwardPrices(req, res);
        return;
      }
      if (pathname === QUOTE_ROUTE) {
        void forwardAssetQuotes(req, res);
        return;
      }
      if (pathname === USDCX_QUOTE_ROUTE) {
        void forwardUsdcxQuote(req, res);
        return;
      }
      const prefix = Object.keys(targets).find((key) => req.url?.startsWith(key)) as keyof typeof targets | undefined;
      if (!prefix) return next();
      void forward(req, res, prefix, apiToken);
    });
  };
  return {
    name: "koios-fetch-proxy",
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
  };
}

type CachedIcon = { body: Uint8Array; contentType: string; expiresAt: number };
const iconCache = new Map<string, CachedIcon>();

async function forwardPrices(req: IncomingMessage, res: ServerResponse) {
  try {
    applySecurityHeaders(res);
    const host = req.headers.host?.toLowerCase() ?? "";
    if (!LOCAL_HOSTS.has(host) || req.method !== "GET") return reject(res, 403, "Invalid price request");
    const parsed = new URL(req.url ?? "", `http://${host}`);
    if ([...parsed.searchParams.keys()].join() !== "source") return reject(res, 400, "Invalid price request");
    const source = parsed.searchParams.get("source");
    if (source !== "coingecko" && source !== "okx") return reject(res, 400, "Invalid price source");
    const upstream = await fetch(PRICE_URLS[source], { redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!upstream.ok) return reject(res, 502, "Price unavailable");
    const length = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(length) && length > 64_000) return reject(res, 502, "Price response too large");
    const bytes = await readLimited(upstream, 64_000);
    if (!bytes) return reject(res, 502, "Price response too large");
    res.setHeader("content-type", "application/json");
    res.end(Buffer.from(bytes));
  } catch { applySecurityHeaders(res); reject(res, 502, "Price unavailable"); }
}

async function forwardAssetQuotes(req: IncomingMessage, res: ServerResponse) {
  try {
    applySecurityHeaders(res);
    const host = req.headers.host?.toLowerCase() ?? "";
    if (!LOCAL_HOSTS.has(host) || req.method !== "GET") return reject(res, 403, "Invalid quote request");
    const parsed = new URL(req.url ?? "", `http://${host}`);
    if ([...parsed.searchParams.keys()].join() !== "ids") return reject(res, 400, "Invalid quote request");
    const ids = (parsed.searchParams.get("ids") ?? "").split(",");
    if (!ids.length || ids.length > 30 || ids.some((id) => !/^[0-9a-f]{56,120}$/.test(id)))
      return reject(res, 400, "Invalid asset IDs");
    const upstream = await fetch(`https://api.dexscreener.com/tokens/v1/cardano/${ids.join(",")}`, {
      redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) return reject(res, 502, "Quotes unavailable");
    const length = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(length) && length > 1_000_000) return reject(res, 502, "Quote response too large");
    const bytes = await readLimited(upstream, 1_000_000);
    if (!bytes) return reject(res, 502, "Quote response too large");
    res.setHeader("content-type", "application/json");
    res.end(Buffer.from(bytes));
  } catch { applySecurityHeaders(res); reject(res, 502, "Quotes unavailable"); }
}

async function forwardUsdcxQuote(req: IncomingMessage, res: ServerResponse) {
  try {
    applySecurityHeaders(res);
    const host = req.headers.host?.toLowerCase() ?? "";
    if (!LOCAL_HOSTS.has(host) || req.method !== "GET" || (req.url ?? "").includes("?"))
      return reject(res, 403, "Invalid USDCx quote request");
    const upstream = await fetch(`https://api-mainnet-prod.minswap.org/v1/assets/${USDCX_ASSET_ID}/metrics?currency=usd`, {
      redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) return reject(res, 502, "USDCx quote unavailable");
    const length = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(length) && length > 64_000) return reject(res, 502, "USDCx quote response too large");
    const bytes = await readLimited(upstream, 64_000);
    if (!bytes) return reject(res, 502, "USDCx quote response too large");
    res.setHeader("content-type", "application/json");
    res.end(Buffer.from(bytes));
  } catch { applySecurityHeaders(res); reject(res, 502, "USDCx quote unavailable"); }
}

const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

// Token logos are remote, attacker-controllable content. The proxy accepts only
// fixed IPFS/Arweave gateways, resolves DNS and refuses private ranges, follows
// no redirects, caps size, and only returns raster image content types.
async function forwardIcon(req: IncomingMessage, res: ServerResponse) {
  try {
    applySecurityHeaders(res);
    const host = req.headers.host?.toLowerCase() ?? "";
    if (!LOCAL_HOSTS.has(host)) return reject(res, 403, "Invalid local host");
    if (req.method !== "GET") return reject(res, 405, "Method not allowed");
    const parsed = new URL(req.url ?? "", `http://${host}`);
    const source = parsed.searchParams.get("u") ?? "";
    if (!source || source.length > 2048 || [...parsed.searchParams.keys()].length !== 1) return reject(res, 400, "Invalid icon request");
    const targets = iconTargetUrls(source);
    if (!targets.length) return reject(res, 400, "Unsupported icon source");
    for (const target of targets) {
      if (!(await publicHostOnly(target))) return reject(res, 400, "Icon host is not allowed");
    }

    const cached = iconCache.get(source);
    if (cached) {
      if (cached.expiresAt <= Date.now()) iconCache.delete(source);
      else {
        res.statusCode = 200;
        res.setHeader("content-type", cached.contentType);
        res.setHeader("cache-control", "private, max-age=86400");
        res.end(Buffer.from(cached.body));
        return;
      }
    }
    for (const target of targets) {
      const fetched = await fetchIcon(target);
      if (!fetched) continue;
      while (iconCache.size >= ICON_CACHE_ENTRIES) {
        const oldest = iconCache.keys().next().value;
        if (!oldest) break;
        iconCache.delete(oldest);
      }
      iconCache.set(source, { body: fetched.body, contentType: fetched.contentType, expiresAt: Date.now() + ICON_CACHE_TTL_MS });
      res.statusCode = 200;
      res.setHeader("content-type", fetched.contentType);
      res.setHeader("cache-control", "private, max-age=86400");
      res.end(Buffer.from(fetched.body));
      return;
    }
    reject(res, 502, "Icon fetch failed");
  } catch (error) {
    console.error("Icon proxy failed:", error instanceof Error ? error.message : "unknown error");
    applySecurityHeaders(res);
    res.statusCode = 502;
    res.end("Icon proxy failed");
  }
}

async function fetchIcon(target: URL): Promise<{ body: Uint8Array; contentType: string } | null> {
  try {
    const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > ICON_MAX_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (!reader) return null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > ICON_MAX_BYTES) return null;
      chunks.push(value);
    }
    const body = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { body, contentType };
  } catch {
    return null;
  }
}

// ipfs:// sources are tried against a small gateway allowlist in order;
// https and ar:// sources map to exactly one target each.
function iconTargetUrls(source: string): URL[] {
  try {
    if (source.startsWith("ipfs://")) {
      const path = source.slice("ipfs://".length).replace(/^\/?(ipfs\/)?/, "").replace(/[^A-Za-z0-9._\-\/]/g, "");
      if (!path) return [];
      return IPFS_GATEWAYS.map((gateway) => new URL(`${gateway}${path}`));
    }
    const single = iconTargetUrl(source);
    return single ? [single] : [];
  } catch {
    return [];
  }
}

function iconTargetUrl(source: string): URL | null {
  try {
    if (source.startsWith("ar://")) {
      const path = source.slice("ar://".length).replace(/^\//, "");
      return /^[A-Za-z0-9_\-]+$/.test(path) ? new URL(`https://arweave.net/${path}`) : null;
    }
    if (!source.startsWith("https://")) return null;
    const url = new URL(source);
    if (url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;
    if (!ALLOWED_ICON_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

function isPrivateAddress(ip: string): boolean {
  if (/^(0|127|10)\./.test(ip)) return true;
  if (/^192\.168\./.test(ip) || /^169\.254\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip === "::1" || ip === "::" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

async function publicHostOnly(url: URL): Promise<boolean> {
  try {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(":")) {
      return !isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""));
    }
    const records = await lookup(url.hostname, { all: true });
    return records.length > 0 && records.every((record) => !isPrivateAddress(record.address));
  } catch {
    return false;
  }
}

async function forward(req: IncomingMessage, res: ServerResponse, prefix: keyof typeof targets, apiToken?: string) {
  try {
    applySecurityHeaders(res);
    const host = req.headers.host?.toLowerCase() ?? "";
    if (!LOCAL_HOSTS.has(host)) return reject(res, 403, "Invalid local host");
    const parsed = new URL(req.url ?? "", `http://${host}`);
    const upstreamPath = parsed.pathname.slice(prefix.length);
    const expectedOrder = upstreamPath === "/api/v1/address_txs" ? "block_height.desc,tx_hash.desc"
      : ["/api/v1/address_utxos", "/api/v1/address_outputs"].includes(upstreamPath) ? "tx_hash.asc,tx_index.asc" : null;
    if (parsed.search && parsed.search !== (upstreamPath === "/api/v1/address_info" ? "?select=address" : `?order=${expectedOrder}`))
      return reject(res, 400, "Unsupported Koios query");
    const expectedMethod = allowedRoutes.get(upstreamPath);
    const method = req.method ?? "GET";
    if (!expectedMethod || method !== expectedMethod) return reject(res, 405, "Unsupported Koios request");
    if (method === "POST" && !isSameOrigin(req, host)) return reject(res, 403, "Cross-origin request rejected");
    const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].toLowerCase();
    const expectedType = upstreamPath === "/api/v1/submittx" ? "application/cbor" : "application/json";
    if (method === "POST" && contentType !== expectedType) return reject(res, 415, "Unsupported content type");
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const rawChunk of req) {
      const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
      received += chunk.byteLength;
      if (received > MAX_REQUEST_BYTES) return reject(res, 413, "Request too large");
      chunks.push(chunk);
    }
    const headers = new Headers();
    if (req.headers["content-type"]) headers.set("content-type", req.headers["content-type"]);
    const range = req.headers.range;
    if (range) {
      if (typeof range !== "string" || !/^\d{1,7}-\d{1,7}$/.test(range)) return reject(res, 400, "Invalid Koios range");
      headers.set("range", range);
    }
    const prefer = req.headers.prefer;
    if (prefer) {
      if (!expectedOrder || (prefer !== "count=exact" && !(upstreamPath === "/api/v1/address_txs" && prefer === "count=planned"))) return reject(res, 400, "Invalid Koios preference");
      headers.set("prefer", prefer);
    }
    if (apiToken) headers.set("authorization", `Bearer ${apiToken}`);
    const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    const url = `${targets[prefix]}${upstreamPath}${parsed.search}`;
    const cacheable = !url.endsWith("/submittx");
    const cacheKey = `${method}:${url}:${range ?? ""}:${prefer ?? ""}:${body?.toString("base64") ?? ""}`;
    const cached = cacheable ? responseCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt <= Date.now()) responseCache.delete(cacheKey);
    let result = cached && cached.expiresAt > Date.now() ? cached : undefined;
    if (!result) {
      let pending = cacheable ? inFlight.get(cacheKey) : undefined;
      if (!pending) {
        pending = fetchKoios(url, { method, headers, body }, cacheable ? cacheTtl(url) : 0);
        if (cacheable) inFlight.set(cacheKey, pending);
      }
      try { result = await pending; }
      finally { if (cacheable) inFlight.delete(cacheKey); }
      if (cacheable && result.status >= 200 && result.status < 300) {
        pruneCache();
        responseCache.set(cacheKey, result);
      }
    }
    res.statusCode = result.status;
    if (result.contentType) res.setHeader("content-type", result.contentType);
    if (result.contentRange) res.setHeader("content-range", result.contentRange);
    res.end(Buffer.from(result.body));
  } catch (error) {
    console.error("Koios proxy failed:", error instanceof Error ? error.message : "unknown error");
    applySecurityHeaders(res);
    res.statusCode = 502;
    res.end("Koios proxy failed");
  }
}

async function fetchKoios(url: string, init: RequestInit, ttl: number): Promise<CachedResponse> {
  const fallbackDelays = url.endsWith("/submittx") ? [0] : [0, 750, 1500, 3000, 6000];
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < fallbackDelays.length; attempt++) {
    const delay = attempt === 0 ? 0 : retryDelay(lastResponse, fallbackDelays[attempt]);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      lastResponse = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (lastResponse.status !== 429 && lastResponse.status < 500) break;
      if (attempt < fallbackDelays.length - 1) await readLimited(lastResponse, MAX_RESPONSE_BYTES);
    } catch (error) {
      lastError = error;
      lastResponse = undefined;
    }
  }
  if (!lastResponse) throw lastError ?? new Error("Koios unavailable");
  const declaredLength = Number(lastResponse.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Koios response too large");
  const body = await readLimited(lastResponse, MAX_RESPONSE_BYTES);
  if (!body) throw new Error("Koios response too large");
  return {
    status: lastResponse.status,
    contentType: lastResponse.headers.get("content-type"),
    contentRange: lastResponse.headers.get("content-range"),
    body,
    expiresAt: Date.now() + ttl,
  };
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function retryDelay(response: Response | undefined, fallback: number) {
  const raw = response?.headers.get("retry-after");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, fallback), 15_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), fallback), 15_000) : fallback;
}

function cacheTtl(url: string) {
  if (url.endsWith("/cli_protocol_params")) return 5 * 60_000;
  if (url.endsWith("/tip")) return 5_000;
  return 20_000;
}

function isSameOrigin(req: IncomingMessage, host: string) {
  const origin = req.headers.origin;
  return origin === `http://${host}` || (!origin && req.headers["sec-fetch-site"] === "same-origin");
}

function reject(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(message);
}

function applySecurityHeaders(res: ServerResponse) {
  for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
}

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of responseCache) if (value.expiresAt <= now) responseCache.delete(key);
  while (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (!oldest) break;
    responseCache.delete(oldest);
  }
}

async function forwardBlockfrost(req: IncomingMessage, res: ServerResponse) {
  applySecurityHeaders(res);
  const host = req.headers.host?.toLowerCase() ?? "";
  if (!LOCAL_HOSTS.has(host) || (req.headers.origin && req.headers.origin !== `http://${host}`))
    return reject(res, 403, "Invalid Blockfrost origin");
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) return reject(res, 413, "Request too large");
      chunks.push(Buffer.from(chunk));
    }
    const result = await proxyBlockfrost(req.url ?? "", req.method ?? "", String(req.headers.project_id ?? ""),
      String(req.headers["content-type"] ?? ""), req.method === "POST" ? Buffer.concat(chunks) : null,
      (url, init) => fetch(url, init));
    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json");
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch { reject(res, 502, "Blockfrost unavailable"); }
}
