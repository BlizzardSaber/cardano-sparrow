import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchChainContext, fetchStakingState, fetchWallet } from "./provider";
import type { DerivedAddress } from "./types";

afterEach(() => vi.unstubAllGlobals());

function koiosRows(value: unknown[]) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-range": value.length ? `0-${value.length - 1}/${value.length}` : "*/0" },
  });
}

describe("wallet history discovery", () => {
  test("splits a large wallet's address requests below the Koios 413 limit", async () => {
    const addresses = Array.from({ length: 100 }, (_, index) => ({
      index, address: `addr_test_${index}`, scriptCborHex: "00", keyHashes: [],
    })) satisfies DerivedAddress[];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { _addresses: string[] };
      if (body._addresses.length > 20) return new Response("too large", { status: 413 });
      return koiosRows([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchWallet(addresses, "preprod");
    expect(result.utxos).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(15);
  });
  test("reports a useful error when the public Koios tier is exhausted", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Too Many Requests", { status: 429 })));
    await expect(fetchWallet(addresses, "preprod")).rejects.toThrow(/配置免费的 API Token/);
  });

  test("marks spent and unspent historical output addresses as used", async () => {
    const addresses = [0, 1, 2].map((index) => ({
      index,
      address: `addr_test_${index}`,
      scriptCborHex: "00",
      keyHashes: [],
    })) satisfies DerivedAddress[];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("address_txs")) expect(new Headers(init?.headers).get("prefer")).toBe("count=planned");
      return koiosRows(
      url.includes("address_info")
        ? [{ address: "addr_test_0", is_spent: true }, { address: "addr_test_1", is_spent: false }]
        : url.includes("tx_info")
          ? [{
              tx_hash: "cd".repeat(32),
              inputs: [{ value: "5000000", payment_addr: { bech32: "addr_test_0" }, asset_list: [] }],
              outputs: [
                { value: "1000000", payment_addr: { bech32: "addr_test_external" }, asset_list: [] },
                { value: "3800000", payment_addr: { bech32: "addr_test_1" }, asset_list: [] },
              ],
            }]
        : url.includes("address_txs")
          ? [{ tx_hash: "cd".repeat(32), block_height: 123, block_time: 1_700_000_000 }]
        : [{ tx_hash: "ab".repeat(32), tx_index: 0, address: "addr_test_1", value: "5000000", asset_list: [] }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWallet(addresses, "preprod");
    expect(result.usedAddresses).toEqual(["addr_test_0", "addr_test_1"]);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("address_outputs"))).toBe(false);
    expect(result.utxos[0].derivationIndex).toBe(1);
    expect(result.transactions[0]).toMatchObject({
      txHash: "cd".repeat(32),
      blockHeight: 123,
      blockTime: 1_700_000_000,
      direction: "sent",
      netLovelace: -1_200_000n,
    });
  });

  test("calculates incoming ADA across all wallet outputs", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => koiosRows(
      url.includes("tx_info")
        ? [{ tx_hash: "ef".repeat(32), inputs: [], outputs: [{ value: "2500000", payment_addr: { bech32: "addr_test_0" }, asset_list: [] }] }]
        : url.includes("address_txs")
          ? [{ tx_hash: "ef".repeat(32), block_height: 456, block_time: 1_700_000_100 }]
          : url.includes("address_info") ? [{ address: "addr_test_0" }] : [],
    )));

    const result = await fetchWallet(addresses, "preprod");
    expect(result.transactions[0]).toMatchObject({ direction: "received", netLovelace: 2_500_000n });
  });

  test("shows CNT net movement, addresses and fee without confusing change with a recipient", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    const token = (quantity: string) => ({ policy_id: "a".repeat(56), asset_name: "434e54", quantity });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => koiosRows(
      url.includes("tx_info")
        ? [{ tx_hash: "cd".repeat(32), fee: "200000",
            inputs: [{ value: "5000000", payment_addr: { bech32: "addr_test_0" }, asset_list: [token("10")] }],
            outputs: [
              { value: "1800000", payment_addr: { bech32: "addr_test_external" }, asset_list: [token("7")] },
              { value: "3000000", payment_addr: { bech32: "addr_test_0" }, asset_list: [token("3")] },
            ] }]
        : url.includes("address_txs") ? [{ tx_hash: "cd".repeat(32), block_height: 123, block_time: 1_700_000_000 }]
          : [],
    ));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchWallet(addresses, "preprod");
    expect(result.transactions[0]).toMatchObject({ direction: "sent", netLovelace: -2_000_000n,
      feeLovelace: 200_000n, assets: [{ assetNameHex: "434e54", quantity: -7n }],
      outputs: [{ address: "addr_test_external", owned: false }, { address: "addr_test_0", owned: true }] });
    const call = fetchMock.mock.calls.find(([url]) => url.includes("tx_info"));
    expect(JSON.parse(String(call?.[1]?.body))._assets).toBe(true);
  });

  test("rejects malformed and duplicated Koios UTXOs instead of trusting a partial balance", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    const utxo = { tx_hash: "ab".repeat(32), tx_index: 0, address: "addr_test_0", value: "5000000", asset_list: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => koiosRows(
      url.includes("address_utxos") ? [utxo, utxo] : [],
    )));
    await expect(fetchWallet(addresses, "preprod")).rejects.toThrow(/重复的 UTXO/);
  });

  test.each([
    { tx_hash: "ab".repeat(32), tx_index: 0, address: "addr_test_0", value: "5000000" },
    { tx_hash: "ab".repeat(32), tx_index: 0, address: "addr_test_other", value: "5000000", asset_list: [] },
  ])("rejects incomplete or foreign Koios UTXOs", async (utxo) => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => koiosRows(url.includes("address_utxos") ? [utxo] : [])));
    await expect(fetchWallet(addresses, "preprod")).rejects.toThrow(/UTXO/);
  });

  test("rejects duplicate native asset units inside an output", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    const asset = { policy_id: "a".repeat(56), asset_name: "414243", quantity: "2" };
    const utxo = { tx_hash: "ab".repeat(32), tx_index: 0, address: "addr_test_0", value: "5000000", asset_list: [asset, asset] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => koiosRows(url.includes("address_utxos") ? [utxo] : [])));
    await expect(fetchWallet(addresses, "preprod")).rejects.toThrow(/重复的资产条目/);
  });

  test("reads every UTXO page before reporting the wallet balance", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    const utxos = Array.from({ length: 501 }, (_, index) => ({
      tx_hash: index.toString(16).padStart(64, "0"), tx_index: 0,
      address: "addr_test_0", value: "1000000", asset_list: [],
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes("address_utxos")) return koiosRows([]);
      expect(new Headers(init?.headers).get("prefer")).toBe("count=exact");
      const range = new Headers(init?.headers).get("range");
      const batch = range === "0-499" ? utxos.slice(0, 500) : utxos.slice(500);
      return new Response(JSON.stringify(batch), {
        status: 200,
        headers: { "content-range": range === "0-499" ? "0-499/501" : "500-500/501" },
      });
    }));
    const result = await fetchWallet(addresses, "preprod");
    expect(result.utxos).toHaveLength(501);
  });

  test("fails closed if Koios omits pagination proof", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      tx_hash: "ab".repeat(32), tx_index: 0, address: "addr_test_0", value: "1000000",
    }]), { status: 200 })));
    await expect(fetchWallet(addresses, "preprod")).rejects.toThrow(/分页结果不完整/);
  });

  test("fails closed if Koios declares more rows than it returned", async () => {
    const addresses = [{ index: 0, address: "addr_test_0", scriptCborHex: "00", keyHashes: [] }] satisfies DerivedAddress[];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      tx_hash: "ab".repeat(32), tx_index: 0, address: "addr_test_0", value: "1000000",
    }]), { status: 200, headers: { "content-range": "0-0/2" } })));
    await expect(fetchWallet(addresses, "preprod")).rejects.toThrow(/分页提前结束/);
  });

  test("rejects implausible Koios protocol parameters before constructing a transaction", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("cli_protocol_params")
        ? { txFeePerByte: -1, txFeeFixed: 155381, utxoCostPerByte: 4310, stakeAddressDeposit: 2000000 }
        : [{ abs_slot: "123456" }],
    ), { status: 200 })));
    await expect(fetchChainContext("preprod")).rejects.toThrow(/链参数无效/);
  });

  test.each([200944541, "200944541"])("accepts Koios tip slot as %s", async (slot) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("cli_protocol_params")
        ? { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, stakeAddressDeposit: 2000000 }
        : [{ abs_slot: slot }],
    ), { status: 200 })));
    await expect(fetchChainContext("mainnet")).resolves.toMatchObject({ tipSlot: 200944541n });
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1.5", "-1"])("rejects invalid Koios tip slot %s", async (slot) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("cli_protocol_params")
        ? { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310, stakeAddressDeposit: 2000000 }
        : [{ abs_slot: slot }],
    ), { status: 200 })));
    await expect(fetchChainContext("preprod")).rejects.toThrow(/链参数无效/);
  });
});

describe("staking state validation", () => {
  const stakeAddress = "stake_test1example";
  test("accepts a registered account with explicit rewards and deposit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      stake_address: stakeAddress, status: "registered", rewards_available: "1234567",
      delegated_pool: null, deposit: "2000000",
    }]), { status: 200 })));
    await expect(fetchStakingState("preprod", stakeAddress)).resolves.toMatchObject({
      registered: true, rewardsLovelace: 1234567n, depositLovelace: 2000000n,
    });
  });

  test.each([
    { status: "registered", rewards_available: "x", deposit: "2000000" },
    { status: "registered", rewards_available: "0", deposit: null },
    { status: "unknown", rewards_available: "0", deposit: "2000000" },
  ])("rejects ambiguous staking information", async (partial) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      stake_address: stakeAddress, delegated_pool: null, ...partial,
    }]), { status: 200 })));
    await expect(fetchStakingState("preprod", stakeAddress)).rejects.toThrow(/质押账户信息无效/);
  });
});
