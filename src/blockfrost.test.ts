import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as C from "@emurgo/cardano-serialization-lib-nodejs";
import { bech32 } from "bech32";
import { activeSource, saveSourceSettings, SourceHttpError, sourceSettings, withSource } from "./data-source";
import { bfAccount, bfAddressUtxos, bfAmounts } from "./blockfrost";
import { broadcast, fetchChainContext, fetchWallet, verifyPackageSources } from "./provider";
import { buildStakingTransaction, buildUnsignedTransaction, deriveAddresses, rewardAddressOf } from "./cardano";
import type { Descriptor, Utxo } from "./types";

const KEY = "mainnet" + "a".repeat(32);
const POLICY = "bb".repeat(28);
const HASH = "aa".repeat(32);
const PARAMS = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, stakeAddressDeposit: 2000000 };
const BF_PARAMS = { min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: "4310", key_deposit: "2000000" };
const json = (v: unknown, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers });
beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) });
  saveSourceSettings({ mode: "auto", mainnet: KEY, preprod: KEY, verify: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("provider selection", () => {
  test("falls back on outages, but never invalid data or cancellation", async () => {
    const run = vi.fn(async (source: string) => { if (source === "koios") throw new SourceHttpError("koios", 429); return "fallback"; });
    await expect(withSource("mainnet", run)).resolves.toBe("fallback");
    expect(activeSource("mainnet")).toBe("blockfrost");
    saveSourceSettings({ ...sourceSettings(), mode: "auto" });
    const malformed = vi.fn(async () => { throw new Error("invalid UTXO"); });
    await expect(withSource("mainnet", malformed)).rejects.toThrow("invalid UTXO");
    expect(malformed).toHaveBeenCalledTimes(1);
    const badShape = vi.fn(async () => { throw new TypeError("malformed data access"); });
    await expect(withSource("mainnet", badShape)).rejects.toThrow("malformed data access");
    expect(badShape).toHaveBeenCalledTimes(1);
    const aborted = vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); });
    await expect(withSource("mainnet", aborted)).rejects.toThrow("cancelled");
    expect(aborted).toHaveBeenCalledTimes(1);
  });
  test("manual mode preserves the real provider error", async () => {
    saveSourceSettings({ ...sourceSettings(), mode: "blockfrost" });
    const run = vi.fn(async () => { throw new SourceHttpError("blockfrost", 403); });
    await expect(withSource("mainnet", run)).rejects.toThrow(/Blockfrost.*403/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(() => saveSourceSettings({ ...sourceSettings(), mainnet: "bad\r\nkey" })).toThrow(/格式/);
  });
});

describe("Blockfrost normalization", () => {
  test("rejects duplicate units, missing ADA and malformed asset names", () => {
    expect(() => bfAmounts([{ unit: "lovelace", quantity: "1" }, { unit: "lovelace", quantity: "1" }])).toThrow(/重复/);
    expect(() => bfAmounts([{ unit: POLICY, quantity: "1" }])).toThrow(/缺少 ADA/);
    expect(() => bfAmounts([{ unit: "lovelace", quantity: "1" }, { unit: POLICY + "f", quantity: "1" }])).toThrow(/单位/);
  });
  test("paginates through the terminating short page and rejects repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const page = new URL(url, "https://local").searchParams.get("page");
      return json(Array.from({ length: page === "1" ? 100 : 1 }, (_, i) => ({
        tx_hash: HASH, output_index: page === "1" ? i : 100, address: "addr1qtest", amount: [{ unit: "lovelace", quantity: "2000000" }],
      })));
    }));
    expect(await bfAddressUtxos("mainnet", "addr1qtest")).toHaveLength(101);
    vi.stubGlobal("fetch", vi.fn(async () => json(Array.from({ length: 2 }, () => ({ tx_hash: HASH, output_index: 0, address: "addr1qtest", amount: [{ unit: "lovelace", quantity: "1" }] })))));
    await expect(bfAddressUtxos("mainnet", "addr1qtest")).rejects.toThrow(/重复/);
  });
  test("uses total withdrawable rewards and real registration deposit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/registrations")
      ? json([{ action: "registered", deposit: "2000000" }])
      : json({ stake_address: "stake1qtest", registered: true, active: false, pool_id: null, withdrawable_amount: "5000000", rewards_sum: "90000000" })));
    expect(await bfAccount("mainnet", "stake1qtest")).toEqual([{ stake_address: "stake1qtest", status: "registered", delegated_pool: null,
      rewards_available: "5000000", rewards_sum: "90000000", withdrawals_sum: null, deposit: "2000000" }]);
  });
  test("normalizes a complete wallet including CNT history and protocol parameters", async () => {
    const address = "addr1qtest";
    const amount = [{ unit: "lovelace", quantity: "20000000" }, { unit: POLICY + "01", quantity: "200" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/koios")) return json({}, 503);
      if (url.includes("/addresses/") && url.includes("/utxos")) return json([{ tx_hash: HASH, output_index: 0, address, amount }]);
      if (url.includes("/transactions")) return json([{ tx_hash: HASH, block_height: 1, block_time: 100 }]);
      if (url.includes("/addresses/")) return json({ address });
      if (url.includes("/txs/") && url.endsWith("/utxos")) return json({ hash: HASH, inputs: [], outputs: [{ address, amount }] });
      if (url.includes("/txs/")) return json({ hash: HASH, fees: "200000", valid_contract: true });
      if (url.includes("/parameters")) return json(BF_PARAMS);
      if (url.endsWith("/blocks/latest")) return json({ slot: 10000000 });
      throw new Error("unexpected endpoint " + url);
    }));
    const wallet = await fetchWallet([{ index: 0, address, keyHashes: [], scriptCborHex: "" }], "mainnet");
    expect(wallet.utxos[0].assets?.[0].quantity).toBe(200n);
    expect(wallet.transactions[0].assets[0].quantity).toBe(200n);
    expect(wallet.usedAddresses).toEqual([address]);
    expect(activeSource("mainnet")).toBe("blockfrost");
    expect((await fetchChainContext("mainnet")).protocol).toEqual(PARAMS);
  });
});

function fixture() {
  const descriptor: Descriptor = { format: "cardano-hd-multisig", version: 1, network: "preprod", account: 0, threshold: 1, gapLimit: 2,
    cosigners: [1].map((seed) => ({ name: "test", accountXpub: bech32.encode("acct_shared_xvk", bech32.toWords(C.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16).fill(seed), new Uint8Array()).derive(0x80000000 + 1854).derive(0x80000000 + 1815).derive(0x80000000).to_public().as_bytes()), 200) })) };
  const addresses = deriveAddresses(descriptor);
  const utxos: Utxo[] = [{ txHash: HASH, txIndex: 0, address: addresses[0].address, derivationIndex: 0, lovelace: 20000000n, assets: [] }];
  const pkg = buildUnsignedTransaction({ descriptor, addresses, utxos, destination: addresses[1].address, amountLovelace: 5000000n, protocol: PARAMS, tipSlot: 10000000n });
  return { descriptor, utxos, pkg };
}
describe("transaction cross-check", () => {
  function mockSources(address: string, bfValue = "20000000", bfStatus = 200, bfTip = 10000001, bfFee = 44) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const bf = url.startsWith("/blockfrost");
      if (bf && bfStatus !== 200) return json({}, bfStatus);
      if (url.includes("address_utxos")) return json([{ tx_hash: HASH, tx_index: 0, address, value: "20000000", asset_list: [] }], 200, { "content-range": "0-0/1" });
      if (url.includes("/addresses/")) return json([{ tx_hash: HASH, output_index: 0, address, amount: [{ unit: "lovelace", quantity: bfValue }] }]);
      if (url.includes("cli_protocol_params")) return json({ ...PARAMS, irrelevant_extra_field: 9 });
      if (url.includes("/parameters")) return json({ ...BF_PARAMS, min_fee_a: bfFee });
      if (url.endsWith("/tip")) return json([{ abs_slot: 10000000 }]);
      if (url.endsWith("/blocks/latest")) return json({ slot: bfTip });
      throw new Error("unexpected verification request " + url);
    }));
  }
  test("both providers must agree with the local selected inputs", async () => {
    const { descriptor, utxos, pkg } = fixture();
    mockSources(utxos[0].address);
    await expect(verifyPackageSources(pkg, descriptor, utxos)).resolves.toBe(true);
    mockSources(utxos[0].address, "19000000");
    await expect(verifyPackageSources(pkg, descriptor, utxos)).rejects.toThrow(/UTXO 不一致/);
  });
  test("rejects disagreements in protocol parameters and chain tip", async () => {
    const { descriptor, utxos, pkg } = fixture();
    mockSources(utxos[0].address, "20000000", 200, 10000001, 45);
    await expect(verifyPackageSources(pkg, descriptor, utxos)).rejects.toThrow(/链参数/);
    mockSources(utxos[0].address, "20000000", 200, 10001000);
    await expect(verifyPackageSources(pkg, descriptor, utxos)).rejects.toThrow(/链参数/);
  });
  test("compares withdrawable rewards against both providers and local staking state", async () => {
    const { descriptor, utxos } = fixture();
    const addresses = deriveAddresses(descriptor), stakeAddress = rewardAddressOf(descriptor);
    const pkg = buildStakingTransaction({ descriptor, addresses, utxos, receiveAddress: addresses[1].address,
      action: { type: "withdraw" }, rewardsLovelace: 5000000n, keyDeposit: 2000000n, protocol: PARAMS, tipSlot: 10000000n });
    mockSources(utxos[0].address);
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/account_info")) return json([{ stake_address: stakeAddress, status: "registered", rewards_available: "5000000", deposit: "2000000", delegated_pool: null }]);
      if (url.includes("/registrations")) return json([{ action: "registered", deposit: "2000000" }]);
      if (url.includes("/accounts/")) return json({ stake_address: stakeAddress, registered: true, pool_id: null, withdrawable_amount: "4000000" });
      return baseFetch(url, init);
    }));
    await expect(verifyPackageSources(pkg, descriptor, utxos, { registered: true, rewardsLovelace: 5000000n, keyDeposit: 2000000n })).rejects.toThrow(/质押状态不一致/);
  });
  test("never automatically resubmits a broadcast through another provider", async () => {
    const { pkg } = fixture();
    saveSourceSettings({ ...sourceSettings(), mode: "blockfrost" });
    const fetch = vi.fn(async () => json({}, 503)); vi.stubGlobal("fetch", fetch);
    await expect(broadcast(pkg.txCborHex, "preprod")).rejects.toThrow(/Blockfrost.*503/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test("a failed backup blocks strict verification instead of silently falling back", async () => {
    const { descriptor, utxos, pkg } = fixture();
    mockSources(utxos[0].address, "20000000", 503);
    await expect(verifyPackageSources(pkg, descriptor, utxos)).rejects.toThrow(/Blockfrost.*503/);
    saveSourceSettings({ ...sourceSettings(), verify: false });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("must not fetch"); }));
    await expect(verifyPackageSources(pkg, descriptor, utxos)).resolves.toBe(false);
  });
});
