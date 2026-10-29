import { app, BrowserWindow, ipcMain, net, protocol, session, shell, systemPreferences } from "electron";
import { readFile, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isAppOrigin } from "./origin.mjs";
import { fetchWithRetry } from "./koios-retry.mjs";
import { proxyBlockfrost } from "./blockfrost-proxy.mjs";

const SCHEME = "cardano-sparrow";
const APP_ORIGIN = `${SCHEME}://app`;
let cameraPermissionUntil = 0;
const LEDGER_VENDOR_ID = 0x2c97;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const ICON_ROUTE = "/asset-icon";
const PRICE_ROUTE = "/market-prices";
const QUOTE_ROUTE = "/asset-quotes";
const USDCX_QUOTE_ROUTE = "/usdcx-quote";
const USDCX_ASSET_ID = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378";
const PRICE_URLS = new Map([
  ["coingecko", "https://api.coingecko.com/api/v3/simple/price?ids=cardano,midnight-3&vs_currencies=usd,cny&include_last_updated_at=true"],
  ["okx", "https://www.okx.com/api/v5/market/ticker?instId=ADA-USDT"],
]);
const ICON_MAX_BYTES = 512 * 1024;
const ICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ICON_CACHE_ENTRIES = 128;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const ALLOWED_ICON_HOSTS = new Set(["ipfs.io", "dweb.link", "gateway.pinata.cloud", "arweave.net"]);
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const targets = new Map([
  ["/koios-mainnet", "https://api.koios.rest"],
  ["/koios-preprod", "https://preprod.koios.rest"],
]);
const routes = new Map([
  ["/api/v1/cli_protocol_params", "GET"], ["/api/v1/tip", "GET"],
  ["/api/v1/address_utxos", "POST"], ["/api/v1/address_outputs", "POST"],
  ["/api/v1/address_info", "POST"],
  ["/api/v1/address_txs", "POST"], ["/api/v1/tx_info", "POST"],
  ["/api/v1/asset_info", "POST"], ["/api/v1/account_info", "POST"],
  ["/api/v1/pool_info", "POST"], ["/api/v1/submittx", "POST"],
]);
const orderedRoutes = new Map([
  ["/api/v1/address_utxos", "tx_hash.asc,tx_index.asc"],
  ["/api/v1/address_outputs", "tx_hash.asc,tx_index.asc"],
  ["/api/v1/address_txs", "block_height.desc,tx_hash.desc"],
]);
const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), hid=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  configurePermissions(session.defaultSession);
  protocol.handle(SCHEME, handleRequest);
  const window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 960, minHeight: 680,
    backgroundColor: "#f5f5f7", title: "Cardano Sparrow",
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: resolve(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      webSecurity: true, devTools: false, spellcheck: false,
    },
  });
  window.removeMenu();
  ipcMain.handle("camera:request-permission", async (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame?.url !== `${APP_ORIGIN}/`) return "blocked";
    if (process.platform !== "darwin") {
      cameraPermissionUntil = Date.now() + 30_000;
      return "granted";
    }
    const status = systemPreferences.getMediaAccessStatus("camera");
    const granted = status === "granted" ||
      (status === "not-determined" && await systemPreferences.askForMediaAccess("camera"));
    if (granted) cameraPermissionUntil = Date.now() + 30_000;
    return granted ? "granted" : "denied";
  });
  window.webContents.on("will-navigate", (event, url) => { if (!isAppOrigin(url)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = safeUrl(url);
    if (parsed?.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
        ["cardanoscan.io", "preprod.cardanoscan.io"].includes(parsed.hostname)) void shell.openExternal(parsed.href);
    return { action: "deny" };
  });
  await window.loadURL(`${APP_ORIGIN}/`);
});

app.on("window-all-closed", () => app.quit());

function configurePermissions(ses) {
  const permitted = isAppOrigin;
  const allowed = (permission) => permission === "hid" || permission === "clipboard-sanitized-write";
  ses.setPermissionCheckHandler((_contents, permission, origin, details) =>
    (permitted(origin) || permitted(details.requestingUrl)) && details.isMainFrame && (allowed(permission) ||
      (permission === "media" && Date.now() < cameraPermissionUntil && details.mediaType === "video")));
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permitted(details.requestingUrl) && details.isMainFrame &&
      (allowed(permission) || (permission === "media" && Date.now() < cameraPermissionUntil &&
        details.mediaTypes?.length === 1 && details.mediaTypes[0] === "video")));
  });
  ses.setDevicePermissionHandler((details) => permitted(details.origin) && details.device.vendorId === LEDGER_VENDOR_ID);
  ses.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    if (!permitted(details.frame?.url)) return callback();
    callback(details.deviceList.find((device) => device.vendorId === LEDGER_VENDOR_ID)?.deviceId);
  });
}

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    if (!isAppOrigin(request.url)) return response("Invalid application request", 400);
    if (new URL(request.url).pathname.startsWith("/blockfrost-")) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await readLimited(request, MAX_REQUEST_BYTES) : null;
      const result = await proxyBlockfrost(url.pathname + url.search, request.method,
        request.headers.get("project_id"), request.headers.get("content-type"), body,
        (target, init) => net.fetch(target, { ...init, bypassCustomProtocolHandlers: true }));
      for (const [key, value] of Object.entries(securityHeaders)) result.headers.set(key, value);
      return result;
    }
    if (url.pathname === ICON_ROUTE) return proxyIcon(request, url);
    if (url.pathname === PRICE_ROUTE) return proxyPrices(request, url);
    if (url.pathname === QUOTE_ROUTE) return proxyAssetQuotes(request, url);
    if (url.pathname === USDCX_QUOTE_ROUTE) return proxyUsdcxQuote(request, url);
    const prefix = [...targets.keys()].find((item) => url.pathname.startsWith(`${item}/`));
    if (!prefix && url.search) return response("Invalid application request", 400);
    return prefix ? proxyKoios(request, url, prefix) : serveAsset(request, url.pathname);
  } catch {
    return response("Application request failed", 500);
  }
}

const iconCache = new Map();

async function proxyPrices(request, url) {
  if (request.method !== "GET" || [...url.searchParams.keys()].join() !== "source") return response("Invalid price request", 400);
  const target = PRICE_URLS.get(url.searchParams.get("source"));
  if (!target) return response("Invalid price source", 400);
  const upstream = await net.fetch(target, { redirect: "error", signal: AbortSignal.timeout(8_000), bypassCustomProtocolHandlers: true });
  if (!upstream.ok) return response("Price unavailable", 502);
  const length = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(length) && length > 64_000) return response("Price response too large", 502);
  const bytes = await readLimited(upstream, 64_000);
  if (!bytes) return response("Price response too large", 502);
  return new Response(bytes, { status: 200, headers: { ...securityHeaders, "Content-Type": "application/json" } });
}

async function proxyAssetQuotes(request, url) {
  if (request.method !== "GET" || [...url.searchParams.keys()].join() !== "ids") return response("Invalid quote request", 400);
  const ids = (url.searchParams.get("ids") ?? "").split(",");
  if (!ids.length || ids.length > 30 || ids.some((id) => !/^[0-9a-f]{56,120}$/.test(id)))
    return response("Invalid asset IDs", 400);
  const target = `https://api.dexscreener.com/tokens/v1/cardano/${ids.join(",")}`;
  const upstream = await net.fetch(target, { redirect: "error", signal: AbortSignal.timeout(8_000), bypassCustomProtocolHandlers: true });
  if (!upstream.ok) return response("Quotes unavailable", 502);
  const length = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(length) && length > 1_000_000) return response("Quote response too large", 502);
  const bytes = await readLimited(upstream, 1_000_000);
  if (!bytes) return response("Quote response too large", 502);
  return new Response(bytes, { status: 200, headers: { ...securityHeaders, "Content-Type": "application/json" } });
}

async function proxyUsdcxQuote(request, url) {
  if (request.method !== "GET" || url.search) return response("Invalid USDCx quote request", 400);
  const target = `https://api-mainnet-prod.minswap.org/v1/assets/${USDCX_ASSET_ID}/metrics?currency=usd`;
  const upstream = await net.fetch(target, { redirect: "error", signal: AbortSignal.timeout(8_000), bypassCustomProtocolHandlers: true });
  if (!upstream.ok) return response("USDCx quote unavailable", 502);
  const length = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(length) && length > 64_000) return response("USDCx quote response too large", 502);
  const bytes = await readLimited(upstream, 64_000);
  if (!bytes) return response("USDCx quote response too large", 502);
  return new Response(bytes, { status: 200, headers: { ...securityHeaders, "Content-Type": "application/json" } });
}
const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

// Token logos are remote, attacker-controllable content. Same policy as the dev
// proxy: https/ipfs/ar only, DNS-checked against private ranges, no redirects,
// size-capped, raster image types only, ipfs gateway fallback chain.
async function proxyIcon(request, url) {
  if (request.method !== "GET") return response("Method not allowed", 405);
  const source = url.searchParams.get("u") ?? "";
  if (!source || source.length > 2048 || [...url.searchParams.keys()].length !== 1) return response("Invalid icon request", 400);
  const targets = iconTargetUrls(source);
  if (!targets.length) return response("Unsupported icon source", 400);
  for (const target of targets) {
    if (!(await publicHostOnly(target))) return response("Icon host is not allowed", 400);
  }

  const cached = iconCache.get(source);
  if (cached) {
    if (cached.expiresAt <= Date.now()) iconCache.delete(source);
    else return new Response(cached.body, { status: 200, headers: { ...securityHeaders, "Content-Type": cached.contentType, "Cache-Control": "private, max-age=86400" } });
  }
  for (const target of targets) {
    const fetched = await fetchIcon(target);
    if (!fetched) continue;
    while (iconCache.size >= ICON_CACHE_ENTRIES) {
      const oldest = iconCache.keys().next().value;
      if (!oldest) break;
      iconCache.delete(oldest);
    }
    iconCache.set(source, { body: fetched.bytes, contentType: fetched.contentType, expiresAt: Date.now() + ICON_CACHE_TTL_MS });
    return new Response(fetched.bytes, { status: 200, headers: { ...securityHeaders, "Content-Type": fetched.contentType, "Cache-Control": "private, max-age=86400" } });
  }
  return response("Icon fetch failed", 502);
}

async function fetchIcon(target) {
  let upstream;
  try {
    upstream = await net.fetch(target, { redirect: "error", signal: AbortSignal.timeout(10_000), bypassCustomProtocolHandlers: true });
  } catch {
    return null;
  }
  if (!upstream.ok) return null;
  const contentType = (upstream.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) return null;
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > ICON_MAX_BYTES) return null;
  const bytes = await readLimited(upstream, ICON_MAX_BYTES);
  if (!bytes) return null;
  return { bytes, contentType };
}

function iconTargetUrls(source) {
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

function iconTargetUrl(source) {
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

function isPrivateAddress(ip) {
  if (/^(0|127|10)\./.test(ip)) return true;
  if (/^192\.168\./.test(ip) || /^169\.254\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip === "::1" || ip === "::" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

async function publicHostOnly(url) {
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

async function serveAsset(request, pathname) {
  if (request.method !== "GET") return response("Method not allowed", 405);
  const decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const path = resolve(distDir, `.${decoded}`);
  if (path !== distDir && !path.startsWith(`${distDir}${sep}`)) return response("Invalid path", 400);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return response("Not found", 404);
  return new Response(await readFile(path), { status: 200, headers: { ...securityHeaders, "Content-Type": mime(extname(path)) } });
}

async function proxyKoios(request, url, prefix) {
  const upstreamPath = url.pathname.slice(prefix.length);
  if (routes.get(upstreamPath) !== request.method) return response("Unsupported Koios request", 405);
  const expectedOrder = orderedRoutes.get(upstreamPath);
  if (url.search && url.search !== (upstreamPath === "/api/v1/address_info" ? "?select=address" : `?order=${expectedOrder}`)) return response("Invalid Koios query", 400);
  const expectedType = upstreamPath === "/api/v1/submittx" ? "application/cbor" : "application/json";
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
  if (request.method === "POST" && contentType !== expectedType) return response("Unsupported content type", 415);
  const declaredRequestLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredRequestLength) && declaredRequestLength > MAX_REQUEST_BYTES) return response("Request too large", 413);
  const body = request.method === "POST" ? await readLimited(request, MAX_REQUEST_BYTES) : undefined;
  if (body === null) return response("Request too large", 413);
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  const range = request.headers.get("range");
  if (range) {
    if (!/^\d{1,7}-\d{1,7}$/.test(range)) return response("Invalid Koios range", 400);
    headers.set("range", range);
  }
  const prefer = request.headers.get("prefer");
  if (prefer) {
    if (!orderedRoutes.has(upstreamPath) || (prefer !== "count=exact" && !(upstreamPath === "/api/v1/address_txs" && prefer === "count=planned"))) return response("Invalid Koios preference", 400);
    headers.set("prefer", prefer);
  }
  if (process.env.KOIOS_API_TOKEN) headers.set("authorization", `Bearer ${process.env.KOIOS_API_TOKEN}`);
  const upstream = await fetchWithRetry(`${targets.get(prefix)}${upstreamPath}${url.search}`, { method: request.method, headers, body },
    (target, init) => net.fetch(target, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000), bypassCustomProtocolHandlers: true }),
    (result) => readLimited(result, MAX_RESPONSE_BYTES));
  const bytes = await readLimited(upstream, MAX_RESPONSE_BYTES);
  if (!bytes) return response("Upstream response too large", 502);
  const responseHeaders = { ...securityHeaders, "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" };
  const result = new Response(bytes, { status: upstream.status, headers: responseHeaders });
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) result.headers.set("Content-Range", contentRange);
  return result;
}

function response(message, status) {
  return new Response(message, { status, headers: { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}
async function readLimited(upstream, limit) {
  if (!upstream.body) return new Uint8Array();
  const reader = upstream.body.getReader();
  const chunks = [];
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
function safeUrl(value) { try { return new URL(value); } catch { return null; } }
function mime(extension) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" })[extension] ?? "application/octet-stream";
}
