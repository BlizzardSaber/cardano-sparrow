import { describe, expect, it } from "vitest";
import { isListedAsset, isUsdcx, USDCX_NAME, USDCX_POLICY } from "./assets";
import type { AssetMeta } from "./types";

describe("asset display identity", () => {
  it("matches USDCx only by exact policy and asset name", () => {
    expect(isUsdcx(USDCX_POLICY, USDCX_NAME)).toBe(true);
    expect(isListedAsset(USDCX_POLICY, USDCX_NAME)).toBe(true);
    expect(isUsdcx("0" + USDCX_POLICY.slice(1), USDCX_NAME)).toBe(false);
    expect(isUsdcx(USDCX_POLICY, "5553444379")).toBe(false);
  });
  it("includes registry listings but not arbitrary on-chain metadata", () => {
    const policy = "0".repeat(56);
    const meta: AssetMeta = { policyId: policy, assetNameHex: USDCX_NAME, fingerprint: "", name: null, ticker: null, decimals: null, logo: null, source: "onchain" };
    expect(isListedAsset(policy, USDCX_NAME)).toBe(false);
    expect(isListedAsset(policy, USDCX_NAME, meta)).toBe(false);
    expect(isListedAsset(policy, USDCX_NAME, { ...meta, source: "registry" })).toBe(true);
  });
});
