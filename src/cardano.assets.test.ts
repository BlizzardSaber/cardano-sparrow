import { describe, expect, test } from "vitest";
import * as NodeC from "@emurgo/cardano-serialization-lib-nodejs";
import { bech32 } from "bech32";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { buildUnsignedTransaction, deriveAddresses, inspectFinalTransaction, mergeSignedTransactions, validatePackageForWallet, validateUnsignedPackage } from "./cardano";
import { ledgerRequestFromPackage } from "./ledger";
import { signWithTestMnemonic } from "./test-signing";
import type { Descriptor, Utxo } from "./types";

const POLICY_A = "aa".repeat(28);
const POLICY_B = "bb".repeat(28);
const NAME_A = "544f4b454e41"; // "TOKENA"
const NAME_B = "544f4b454e42"; // "TOKENB"
const PROTOCOL = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 };

function fixture() {
  const entropy = [1, 2, 3].map((seed) => new Uint8Array(16).fill(seed));
  const phrases = entropy.map((value) => entropyToMnemonic(value, wordlist));
  const privateKeys = entropy.map((value) => NodeC.Bip32PrivateKey.from_bip39_entropy(value, new Uint8Array())
    .derive(0x80000000 + 1854).derive(0x80000000 + 1815).derive(0x80000000));
  const descriptor: Descriptor = {
    format: "cardano-hd-multisig",
    version: 1,
    network: "preprod",
    threshold: 2,
    account: 0,
    gapLimit: 5,
    cosigners: privateKeys.map((key, index) => ({
      name: `Signer ${index + 1}`,
      accountXpub: bech32.encode("acct_shared_xvk", bech32.toWords(key.to_public().as_bytes()), 200),
    })) as Descriptor["cosigners"],
  };
  return { phrases, descriptor };
}

function assetUtxo(txHash: string, address: string, derivationIndex: number, lovelace: bigint, assets: Array<{ policyId: string; assetNameHex: string; quantity: bigint }>): Utxo {
  return { txHash, txIndex: 0, lovelace, assets, address, derivationIndex };
}

describe("native asset transactions", () => {
  test("sends tokens with automatically padded min-ADA and returns leftover assets as change", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [
      assetUtxo("11".repeat(32), addresses[0].address, 0, 10_000_000n, [
        { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 100n },
      ]),
      assetUtxo("22".repeat(32), addresses[0].address, 0, 10_000_000n, [
        { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 50n },
        { policyId: POLICY_B, assetNameHex: NAME_B, quantity: 7n },
      ]),
      assetUtxo("33".repeat(32), addresses[1].address, 1, 30_000_000n, []),
    ];
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[4].address,
      changeAddress: addresses[2].address,
      amountLovelace: 0n,
      assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: 120n }],
      protocol: PROTOCOL,
      tipSlot: 10_000_000n,
    });

    expect(unsigned.version).toBe(2);
    expect(unsigned.outputs).toHaveLength(2);
    expect(unsigned.outputs[0].assets).toEqual([{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: "120" }]);
    // Payment carries at least the on-chain minimum ADA for an output holding TOKENA.
    const tx = NodeC.Transaction.from_hex(unsigned.txCborHex);
    const dataCost = NodeC.DataCost.new_coins_per_byte(NodeC.BigNum.from_str("4310"));
    const minAda = BigInt(NodeC.min_ada_for_output(tx.body().outputs().get(0), dataCost).to_str());
    expect(BigInt(unsigned.outputs[0].lovelace)).toBeGreaterThanOrEqual(minAda);
    // Change returns TOKENA 30 + TOKENB 7 untouched (canonical policy order).
    expect(unsigned.outputs[1].assets).toEqual([
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: "30" },
      { policyId: POLICY_B, assetNameHex: NAME_B, quantity: "7" },
    ]);
    const inputs = BigInt(unsigned.inputs.length);
    expect(inputs).toBeGreaterThan(0n);
    const totalIn = unsigned.inputs.reduce((sum, input) => sum + (utxos.find((u) => u.txHash === input.txHash)?.lovelace ?? 0n), 0n);
    const totalOut = unsigned.outputs.reduce((sum, output) => sum + BigInt(output.lovelace), 0n) + BigInt(unsigned.feeLovelace);
    expect(totalOut).toBe(totalIn);
    expect(validatePackageForWallet(unsigned, descriptor, addresses, utxos)).toBe(unsigned);
  });

  test("sending the full balance of a sole asset returns leftover ADA as change", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [
      assetUtxo("44".repeat(32), addresses[0].address, 0, 10_000_000n, [
        { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 42n },
      ]),
    ];
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[4].address,
      changeAddress: addresses[2].address,
      amountLovelace: 0n,
      assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: 42n }],
      protocol: PROTOCOL,
      tipSlot: 10_000_000n,
    });

    // The whole TOKENA balance goes out; leftover ADA returns as plain change.
    expect(unsigned.outputs[0].assets).toEqual([{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: "42" }]);
    expect(unsigned.outputs[1].assets).toBeUndefined();
    expect(unsigned.outputs.reduce((sum, output) => sum + BigInt(output.lovelace), 0n) + BigInt(unsigned.feeLovelace)).toBe(10_000_000n);
    expect(validatePackageForWallet(unsigned, descriptor, addresses, utxos)).toBe(unsigned);
  });

  test("rejects sends beyond the held asset balance", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [assetUtxo("55".repeat(32), addresses[0].address, 0, 10_000_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 5n },
    ])];
    expect(() => buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[4].address,
      amountLovelace: 0n,
      assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: 6n }],
      protocol: PROTOCOL,
      tipSlot: 10_000_000n,
    })).toThrow(/资产余额不足/);
  });

  test("rejects repeated requests for one asset before constructing an unbalanced transaction", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [assetUtxo("56".repeat(32), addresses[0].address, 0, 10_000_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 5n },
    ])];
    expect(() => buildUnsignedTransaction({
      descriptor, addresses, utxos,
      destination: addresses[4].address, amountLovelace: 0n,
      assetRequests: [
        { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 4n },
        { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 4n },
      ],
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    })).toThrow(/同一资产/);
  });

  test("rejects zero and negative token quantities instead of silently sending ADA", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [assetUtxo("57".repeat(32), addresses[0].address, 0, 10_000_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 5n },
    ])];
    for (const quantity of [0n, -1n]) {
      expect(() => buildUnsignedTransaction({
        descriptor, addresses, utxos,
        destination: addresses[4].address, amountLovelace: 2_000_000n,
        assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity }],
        protocol: PROTOCOL, tipSlot: 10_000_000n,
      })).toThrow(/资产发送数量必须大于零/);
    }
  });

  test("requires enough ADA to satisfy the asset change minimum", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    // Just enough ADA for the payment output, nothing left for a multi-asset change.
    const utxos = [assetUtxo("66".repeat(32), addresses[0].address, 0, 1_200_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 100n },
      { policyId: POLICY_B, assetNameHex: NAME_B, quantity: 100n },
    ])];
    expect(() => buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[4].address,
      amountLovelace: 0n,
      assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: 50n }],
      protocol: PROTOCOL,
      tipSlot: 10_000_000n,
    })).toThrow(/找零低于链上最小值/);
  });

  test("builds, signs, merges, and inspects an asset transaction end to end", () => {
    const descriptor = fixture().descriptor;
    const { phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [
      assetUtxo("77".repeat(32), addresses[0].address, 0, 20_000_000n, [
        { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 100n },
      ]),
      assetUtxo("88".repeat(32), addresses[1].address, 1, 20_000_000n, []),
    ];
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[4].address,
      changeAddress: addresses[2].address,
      amountLovelace: 2_000_000n,
      assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: 40n }],
      protocol: PROTOCOL,
      tipSlot: 10_000_000n,
    });

    const signed = phrases.slice(0, 2).map((phrase) => signWithTestMnemonic(unsigned, phrase).signedTxHex);
    const merged = mergeSignedTransactions(unsigned.txCborHex, signed);
    const final = inspectFinalTransaction(merged);
    expect(final.outputs[0].assets).toEqual([{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: "40" }]);
    expect(final.outputs[1].assets).toEqual([{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: "60" }]);
    expect(final.witnessCount).toBe(2);
  });

  test("maps asset outputs into the Ledger multisig token bundle", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [assetUtxo("99".repeat(32), addresses[0].address, 0, 20_000_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 10n },
      { policyId: POLICY_B, assetNameHex: NAME_B, quantity: 20n },
    ])];
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[4].address,
      amountLovelace: 0n,
      assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: 10n }],
      protocol: PROTOCOL,
      tipSlot: 10_000_000n,
    });
    const request = ledgerRequestFromPackage(unsigned);
    expect(request.signingMode).toBe("multisig_transaction");
    const payment = request.tx.outputs[0] as { tokenBundle?: Array<{ policyIdHex: string; tokens: Array<{ assetNameHex: string; amount: string }> }> };
    expect(payment.tokenBundle).toEqual([{ policyIdHex: POLICY_A, tokens: [{ assetNameHex: NAME_A, amount: "10" }] }]);
    const change = request.tx.outputs[1] as { tokenBundle?: Array<{ policyIdHex: string; tokens: Array<{ assetNameHex: string; amount: string }> }> };
    expect(change.tokenBundle).toEqual([{ policyIdHex: POLICY_B, tokens: [{ assetNameHex: NAME_B, amount: "20" }] }]);
  });

  test("tampered asset summaries and v1 packages with assets are rejected", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [assetUtxo("ab".repeat(32), addresses[0].address, 0, 20_000_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 100n },
    ])];
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[4].address,
      amountLovelace: 0n,
      assetRequests: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: 30n }],
      protocol: PROTOCOL,
      tipSlot: 10_000_000n,
    });
    expect(validatePackageForWallet(unsigned, descriptor, addresses, utxos)).toBe(unsigned);
    expect(() => validateUnsignedPackage({
      ...unsigned,
      outputs: [{ ...unsigned.outputs[0], assets: [{ policyId: POLICY_A, assetNameHex: NAME_A, quantity: "31" }] }, unsigned.outputs[1]],
    })).toThrow(/摘要与交易 CBOR 不一致/);
    expect(() => validateUnsignedPackage({ ...unsigned, version: 1 })).toThrow(/CIP-1854/);
    // Removing the declared assets entirely also mismatches the CBOR.
    expect(() => validateUnsignedPackage({
      ...unsigned,
      outputs: [{ address: unsigned.outputs[0].address, lovelace: unsigned.outputs[0].lovelace }, unsigned.outputs[1]],
    })).toThrow(/摘要与交易 CBOR 不一致/);
    // Live-utxo balance checks must catch asset mismatch even with a consistent CBOR.
    const tamperedUtxos = [assetUtxo("ab".repeat(32), addresses[0].address, 0, 20_000_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 35n },
    ])];
    expect(() => validatePackageForWallet(unsigned, descriptor, addresses, tamperedUtxos)).toThrow(/不平衡|不存在/);
  });

  test("pure-ADA wallet UTXOs never mix into asset sends and vice versa", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const assetUtxos = [assetUtxo("cd".repeat(32), addresses[0].address, 0, 20_000_000n, [
      { policyId: POLICY_A, assetNameHex: NAME_A, quantity: 100n },
    ])];
    const pure = [assetUtxo("ef".repeat(32), addresses[1].address, 1, 20_000_000n, [])];
    // Pure ADA send selects pure UTXOs only.
    const adaSend = buildUnsignedTransaction({
      descriptor, addresses, utxos: [...assetUtxos, ...pure],
      destination: addresses[4].address, amountLovelace: 5_000_000n,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    expect(adaSend.version).toBe(1);
    expect(adaSend.inputs.map((input) => input.txHash)).toEqual(["ef".repeat(32)]);
    expect(validatePackageForWallet(adaSend, descriptor, addresses, [...assetUtxos, ...pure])).toBe(adaSend);
    // Max ADA send also leaves the asset UTXO untouched.
    const maxSend = buildUnsignedTransaction({
      descriptor, addresses, utxos: [...assetUtxos, ...pure],
      destination: addresses[4].address, amountLovelace: 0n, sendMax: true,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    expect(maxSend.inputs.map((input) => input.txHash)).toEqual(["ef".repeat(32)]);
    expect(maxSend.outputs).toHaveLength(1);
  });
});
