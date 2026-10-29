import { describe, expect, test } from "vitest";
import { blake2b } from "./blake2b";
import { assetFingerprint, assetNameText, bytesToHex, hexToBytes } from "./fingerprint";

describe("CIP-14 asset fingerprints", () => {
  // Official test vectors from CIP-14.
  const vectors: Array<[policy: string, assetName: string, fingerprint: string]> = [
    ["7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "", "asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3"],
    ["7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc37e", "", "asset1nl0puwxmhas8fawxp8nx4e2q3wekg969n2auw3"],
    ["1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209", "", "asset1uyuxku60yqe57nusqzjx38aan3f2wq6s93f6ea"],
    ["7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "504154415445", "asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92"],
    ["1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209", "504154415445", "asset1hv4p5tv2a837mzqrst04d0dcptdjmluqvdx9k3"],
    ["1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209", "7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "asset1aqrdypg669jgazruv5ah07nuyqe0wxjhe2el6f"],
    ["7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209", "asset17jd78wukhtrnmjh3fngzasxm8rck0l2r4hhyyt"],
    ["7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "0000000000000000000000000000000000000000000000000000000000000000", "asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w"],
  ];

  test("matches every official CIP-14 vector", () => {
    for (const [policy, assetName, expected] of vectors) {
      expect(assetFingerprint(policy, assetName)).toBe(expected);
    }
  });

  test("blake2b-512 of the empty input matches the RFC 7693 appendix value", () => {
    expect(bytesToHex(blake2b(new Uint8Array(0), 64)))
      .toBe("786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce");
  });

  test("matches reference digests across sizes and multi-block inputs", () => {
    // Values cross-checked against the blakejs reference implementation.
    expect(bytesToHex(blake2b(new TextEncoder().encode("abc"), 20))).toBe("384264f676f39536840523f284921cdc68b6846b");
    expect(bytesToHex(blake2b(new TextEncoder().encode("abc"), 64))).toBe("ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923");
    expect(bytesToHex(blake2b(new TextEncoder().encode("a".repeat(300)), 64))).toBe("a2ff3040eda405b929c2fc2fd93e8add6ac3bb5369b679bae170ac6956863ca006285f132a868000fc3fae5bc696e5d17fe3fddfb4a342876c40451184742986");
  });

  test("rejects malformed policy ids and asset names", () => {
    expect(() => assetFingerprint("zz", "")).toThrow(/Policy ID/);
    expect(() => assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "w")).toThrow(/资产名称/);
    expect(() => assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "00".repeat(33))).toThrow(/资产名称/);
  });

  test("decodes printable ASCII asset names and keeps hex for binary names", () => {
    expect(assetNameText("504154415445")).toBe("PATATE");
    expect(assetNameText("e4b8ade69687")).toBe("e4b8ade69687");
    expect(assetNameText("")).toBe("");
  });

  test("hex helpers round-trip", () => {
    expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
    expect(() => hexToBytes("0ff")).toThrow(/十六进制/);
  });
});
