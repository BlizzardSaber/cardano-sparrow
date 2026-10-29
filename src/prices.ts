export type FiatPrices = { adaUsd: number | null; adaCny: number | null; nightUsd: number | null;
  nightCny: number | null; source: "CoinGecko" | "OKX"; fetchedAt: number };
export type DexQuote = { usd: number; liquidityUsd: number; volume24hUsd: number; fetchedAt: number;
  source: "DEX Screener" | "Minswap" };

export const USDCX_ASSET_ID = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378";

export function parseDexQuotes(json: unknown, assetIds: string[]): Record<string, DexQuote> {
  if (!Array.isArray(json)) return {};
  const requested = new Set(assetIds);
  const result: Record<string, DexQuote> = {};
  for (const raw of json.slice(0, 300)) {
    if (!raw || typeof raw !== "object") continue;
    const pair = raw as Record<string, unknown>;
    const base = pair.baseToken as Record<string, unknown> | undefined;
    const id = typeof base?.address === "string" ? base.address.toLowerCase() : "";
    const liquidity = (pair.liquidity as Record<string, unknown> | undefined)?.usd;
    const volume = (pair.volume as Record<string, unknown> | undefined)?.h24;
    const usd = typeof pair.priceUsd === "string" && /^\d+(\.\d+)?$/.test(pair.priceUsd)
      ? Number(pair.priceUsd) : null;
    if (pair.chainId !== "cardano" || !requested.has(id) || !usd || !Number.isFinite(usd) || usd <= 0 ||
        typeof liquidity !== "number" || !Number.isFinite(liquidity) || liquidity < 50_000 ||
        typeof volume !== "number" || !Number.isFinite(volume) || volume < 1_000) continue;
    if (!result[id] || result[id].liquidityUsd < liquidity)
      result[id] = { usd, liquidityUsd: liquidity, volume24hUsd: volume, fetchedAt: Date.now(), source: "DEX Screener" };
  }
  return result;
}

export function parseMinswapQuote(json: unknown): DexQuote | null {
  if (!json || typeof json !== "object") return null;
  const row = json as Record<string, unknown>;
  const asset = row.asset as Record<string, unknown> | undefined;
  const metadata = asset?.metadata as Record<string, unknown> | undefined;
  const id = typeof asset?.currency_symbol === "string" && typeof asset.token_name === "string"
    ? `${asset.currency_symbol}${asset.token_name}`.toLowerCase() : "";
  const usd = typeof row.price === "number" ? row.price : null;
  const liquidity = typeof row.liquidity === "number" ? row.liquidity : null;
  const volume = typeof row.volume_24h === "number" ? row.volume_24h : null;
  if (id !== USDCX_ASSET_ID || asset?.is_verified !== true || metadata?.decimals !== 6 ||
      usd === null || !Number.isFinite(usd) || usd <= 0 ||
      liquidity === null || !Number.isFinite(liquidity) || liquidity < 50_000 ||
      volume === null || !Number.isFinite(volume) || volume < 1_000) return null;
  return { usd, liquidityUsd: liquidity, volume24hUsd: volume, fetchedAt: Date.now(), source: "Minswap" };
}

const dexCache = new Map<string, { quotes: Record<string, DexQuote>; fetchedAt: number }>();
let usdcxCache: DexQuote | null = null;
export async function loadDexQuotes(assetIds: string[]): Promise<Record<string, DexQuote>> {
  const ids = [...new Set(assetIds.filter((id) => /^[0-9a-f]{56,120}$/.test(id)))].sort().slice(0, 300);
  const result: Record<string, DexQuote> = {};
  if (ids.includes(USDCX_ASSET_ID)) {
    if (usdcxCache && Date.now() - usdcxCache.fetchedAt < 5 * 60_000) result[USDCX_ASSET_ID] = usdcxCache;
    try {
      if (!result[USDCX_ASSET_ID]) {
        const response = await fetch("/usdcx-quote");
        if (response.ok) {
          const quote = parseMinswapQuote(await response.json());
          if (quote) result[USDCX_ASSET_ID] = usdcxCache = quote;
        }
      }
    } catch { /* Fall through to DEX Screener. */ }
  }
  for (let i = 0; i < ids.length; i += 30) {
    const batch = ids.slice(i, i + 30).filter((id) => id !== USDCX_ASSET_ID || !result[id]);
    if (!batch.length) continue;
    const key = batch.join(",");
    const cached = dexCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
      Object.assign(result, cached.quotes);
      continue;
    }
    try {
      const response = await fetch(`/asset-quotes?ids=${key}`);
      if (!response.ok) continue;
      const quotes = parseDexQuotes(await response.json(), batch);
      if (Object.keys(quotes).length) dexCache.set(key, { quotes, fetchedAt: Date.now() });
      Object.assign(result, quotes);
    } catch { /* Quotes are display-only. */ }
  }
  return result;
}

export const isVerifiedNight = (policyId: string, assetNameHex: string) =>
  policyId.toLowerCase() === "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa" &&
  assetNameHex.toLowerCase() === "4e49474854";

const positive = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const recent = (row: Record<string, unknown> | undefined) => Number.isSafeInteger(row?.last_updated_at) &&
  Math.abs(Date.now() / 1000 - Number(row?.last_updated_at)) < 86_400;

let cached: FiatPrices | null = null;
let inflight: Promise<FiatPrices | null> | null = null;

export function freshPrices(): FiatPrices | null {
  return cached && Date.now() >= cached.fetchedAt && Date.now() - cached.fetchedAt < 5 * 60_000 ? cached : null;
}

async function source(name: "coingecko" | "okx") {
  const response = await fetch(`/market-prices?source=${name}`);
  if (!response.ok) throw new Error(`行情源 ${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function loadPrices(): Promise<FiatPrices | null> {
  if (freshPrices()) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await source("coingecko") as { cardano?: Record<string, unknown>; "midnight-3"?: Record<string, unknown> };
      if (recent(data?.cardano)) {
        const adaUsd = positive(data.cardano?.usd);
        const adaCny = positive(data.cardano?.cny);
        const night = data["midnight-3"];
        if (adaUsd !== null || adaCny !== null) {
          cached = { adaUsd, adaCny, nightUsd: recent(night) ? positive(night?.usd) : null,
            nightCny: recent(night) ? positive(night?.cny) : null, source: "CoinGecko", fetchedAt: Date.now() };
          return cached;
        }
      }
    } catch { /* Use the ADA-only fallback. */ }
    try {
      const data = await source("okx") as { data?: Array<{ last?: unknown }> };
      const last = data?.data?.[0]?.last;
      const adaUsd = typeof last === "string" && /^\d+(\.\d+)?$/.test(last) ? positive(Number(last)) : null;
      if (adaUsd !== null) {
        cached = { adaUsd, adaCny: null, nightUsd: null, nightCny: null, source: "OKX", fetchedAt: Date.now() };
        return cached;
      }
    } catch { /* Prices are optional. */ }
    return null;
  })();
  try { return await inflight; } finally { inflight = null; }
}

export function estimate(quantity: bigint, decimals: number, rate: number | null): number | null {
  if (rate === null) return null;
  const amount = Number(quantity) / 10 ** decimals;
  return Number.isFinite(amount) && amount >= 0 ? amount * rate : null;
}

export function estimateDexValue(quantity: bigint, decimals: number, quote: DexQuote | undefined,
  currency: "usd" | "cny", prices: FiatPrices | null): number | null {
  if (!quote || Date.now() - quote.fetchedAt >= 5 * 60_000) return null;
  const rate = currency === "usd" ? quote.usd : prices?.adaUsd && prices.adaCny
    ? quote.usd * prices.adaCny / prices.adaUsd : null;
  return estimate(quantity, decimals, rate);
}

export function formatFiat(amount: number | null, currency: "usd" | "cny"): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  const digits = amount >= 1000 ? 0 : amount >= 1 ? 2 : 4;
  return `${currency === "usd" ? "$" : "¥"}${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
