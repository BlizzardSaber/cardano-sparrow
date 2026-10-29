import { bech32 } from "bech32";
import { describe, expect, it } from "vitest";
import { CIP1854_ACCOUNT_PATH, encodeAccountXpub, resolvePackageConstructor } from "./ledger";

describe("Ledger CIP-1854 account import", () => {
  it("uses the hardened shared-wallet account path", () => {
    expect(CIP1854_ACCOUNT_PATH).toEqual([0x8000073e, 0x80000717, 0x80000000]);
  });

  it("encodes public key and chain code as acct_shared_xvk", () => {
    const value = encodeAccountXpub("11".repeat(32), "22".repeat(32));
    const decoded = bech32.decode(value, 200);
    expect(decoded.prefix).toBe("acct_shared_xvk");
    expect(Uint8Array.from(bech32.fromWords(decoded.words))).toEqual(
      Uint8Array.from([...Array(32).fill(0x11), ...Array(32).fill(0x22)]),
    );
  });

  it("resolves CommonJS constructors wrapped in nested default exports", () => {
    class Ada {}
    expect(resolvePackageConstructor({ default: { default: Ada, Ada } }, "Ada")).toBe(Ada);
    expect(resolvePackageConstructor({ default: Ada }, "Ada")).toBe(Ada);
    expect(resolvePackageConstructor({ Ada }, "Ada")).toBe(Ada);
  });
});
