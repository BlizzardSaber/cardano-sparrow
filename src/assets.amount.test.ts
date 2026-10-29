import { describe, expect, test } from "vitest";
import { assetDecimals, formatTokenInput, formatTokenQuantity, parseTokenAmount, USDCX_NAME, USDCX_POLICY } from "./assets";

describe("CNT amount input", () => {
  test.each([null, 0, 6])("round-trips a large balance with %s decimals without grouping", (decimals) => {
    const balance = 5_205_390_801n;
    const value = formatTokenInput(balance, decimals);
    expect(value).not.toContain(",");
    expect(parseTokenAmount(value, decimals)).toBe(balance);
    expect(formatTokenQuantity(balance, decimals)).toContain(",");
  });
  test("known NIGHT and USDCx units stay at six decimals before registry metadata loads", () => {
    const nightPolicy = "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa";
    const nightName = "4e49474854";
    expect(assetDecimals(nightPolicy, nightName)).toBe(6);
    expect(assetDecimals(USDCX_POLICY, USDCX_NAME)).toBe(6);
    expect(parseTokenAmount(formatTokenInput(32_046_400n, assetDecimals(USDCX_POLICY, USDCX_NAME)), 6)).toBe(32_046_400n);
  });
});
