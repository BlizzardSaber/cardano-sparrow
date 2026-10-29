import { describe, expect, test } from "vitest";
import { nextReceiveAddress, requiredDiscoverySize } from "./addressing";
import type { DerivedAddress } from "./types";

const addresses = Array.from({ length: 25 }, (_, index) => ({
  index,
  address: `addr_test_${index}`,
  scriptCborHex: "00",
  keyHashes: [],
})) satisfies DerivedAddress[];

describe("single-use receive address selection", () => {
  test("starts at address zero before any address is used", () => {
    expect(nextReceiveAddress(addresses, new Set())?.index).toBe(0);
  });

  test("moves to the index after the highest used address", () => {
    expect(nextReceiveAddress(addresses, new Set([0, 1]))?.index).toBe(2);
    expect(nextReceiveAddress(addresses, new Set([0, 3]))?.index).toBe(4);
  });

  test("maintains a full gap after the highest used address", () => {
    expect(requiredDiscoverySize(20, new Set())).toBe(20);
    expect(requiredDiscoverySize(20, new Set([0, 19]))).toBe(40);
  });
});
