import { afterEach, expect, test, vi } from "vitest";
import { estimate, estimateDexValue, formatFiat, isVerifiedNight, loadPrices, parseDexQuotes, parseMinswapQuote,
  USDCX_ASSET_ID } from "./prices";

afterEach(() => vi.unstubAllGlobals());

test("uses only fresh, positive ADA/NIGHT quotes from a fixed local route", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    cardano: { usd: 1.2, cny: 8.4, last_updated_at: now },
    "midnight-3": { usd: 0.04, cny: 0.28, last_updated_at: now },
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const price = await loadPrices();
  expect(fetchMock).toHaveBeenCalledWith("/market-prices?source=coingecko");
  expect(price).toMatchObject({ adaUsd: 1.2, adaCny: 8.4, nightUsd: 0.04, nightCny: 0.28 });
  expect(estimate(2_500_000n, 6, price!.adaUsd)).toBe(3);
  expect(formatFiat(3, "usd")).toBe("$3.00");
  expect(isVerifiedNight("0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa", "4e49474854")).toBe(true);
  expect(isVerifiedNight("0".repeat(56), "4e49474854")).toBe(false);
});

test("accepts only the verified exact USDCx Minswap metric", () => {
  const valid = { asset: { currency_symbol: USDCX_ASSET_ID.slice(0, 56), token_name: USDCX_ASSET_ID.slice(56),
    is_verified: true, metadata: { decimals: 6 } }, price: 0.998, liquidity: 2_040_140.5, volume_24h: 384_400 };
  expect(parseMinswapQuote(valid)).toMatchObject({ usd: 0.998, source: "Minswap" });
  expect(parseMinswapQuote({ ...valid, asset: { ...valid.asset, token_name: "5553444379" } })).toBeNull();
  expect(parseMinswapQuote({ ...valid, asset: { ...valid.asset, is_verified: false } })).toBeNull();
  expect(parseMinswapQuote({ ...valid, liquidity: 1 })).toBeNull();
  expect(parseMinswapQuote({ ...valid, price: Number.NaN })).toBeNull();
});

test("quotes only the requested Cardano asset in a liquid pool", () => {
  const id = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378";
  const pair = { chainId: "cardano", baseToken: { address: id }, priceUsd: "1.01",
    liquidity: { usd: 100_000 }, volume: { h24: 2_000 } };
  const result = parseDexQuotes([
    { ...pair, baseToken: { address: "0".repeat(id.length) }, priceUsd: "999" },
    { ...pair, priceUsd: "500", liquidity: { usd: 10 } },
    { ...pair, priceUsd: "1.01" },
  ], [id]);
  expect(result[id]?.usd).toBe(1.01);
  expect(Object.keys(result)).toEqual([id]);
  expect(formatFiat(estimateDexValue(32_046_400n, 6, { ...result[id], usd: 1.0019 }, "usd", null), "usd"))
    .toBe("$32.11");
});
