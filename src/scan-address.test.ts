import { describe, expect, test } from "vitest";
import * as C from "@emurgo/cardano-serialization-lib-nodejs";
import { parseScannedAddress } from "./scan-address";

const key = C.Credential.from_keyhash(C.Ed25519KeyHash.from_bytes(new Uint8Array(28).fill(7)));
const mainnet = C.BaseAddress.new(1, key, key).to_address().to_bech32();
const preprod = C.BaseAddress.new(0, key, key).to_address().to_bech32();
const stake = C.RewardAddress.new(1, key).to_address().to_bech32();

describe("scanned recipient address", () => {
  test("accepts only a complete payment address for the selected network", () => {
    expect(parseScannedAddress(mainnet, "mainnet")).toBe(mainnet);
    expect(parseScannedAddress(preprod, "preprod")).toBe(preprod);
    expect(() => parseScannedAddress(preprod, "mainnet")).toThrow();
    expect(() => parseScannedAddress(mainnet, "preprod")).toThrow();
  });
  test("rejects stake, payment URI, corrupted, and oversized QR payloads", () => {
    expect(() => parseScannedAddress(stake, "mainnet")).toThrow();
    expect(() => parseScannedAddress(`cardano:${mainnet}`, "mainnet")).toThrow();
    expect(() => parseScannedAddress(mainnet.slice(0, -1) + "q", "mainnet")).toThrow();
    expect(() => parseScannedAddress("x".repeat(1000), "mainnet")).toThrow();
  });
});
