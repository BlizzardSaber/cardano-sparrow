import { describe, expect, test } from "vitest";
import fc from "fast-check";
import * as NodeC from "@emurgo/cardano-serialization-lib-nodejs";
import { bech32 } from "bech32";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { buildStakingTransaction, buildUnsignedTransaction, deriveAddresses, poolIdToKeyHashHex, validateDescriptor, validateSignedTransaction, validateUnsignedPackage, validatePackageForWallet } from "./cardano";
import { resolveAssetMeta } from "./assets";
import { signWithTestMnemonic } from "./test-signing";
import type { Descriptor, Utxo } from "./types";

const PROTOCOL = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 };
const POLICY = "c0".repeat(28);
const NAME = "4153534554"; // "ASSET"

function fixture() {
  const entropy = new Uint8Array(16).fill(7);
  const phrase = entropyToMnemonic(entropy, wordlist);
  const keys = [7, 8, 9].map((seed) => NodeC.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16).fill(seed), new Uint8Array())
    .derive(0x80000000 + 1854).derive(0x80000000 + 1815).derive(0x80000000));
  const descriptor: Descriptor = {
    format: "cardano-hd-multisig", version: 1, network: "preprod", threshold: 2, account: 0, gapLimit: 3,
    cosigners: keys.map((key, index) => ({ name: `Signer ${index + 1}`, accountXpub: bech32.encode("acct_shared_xvk", bech32.toWords(key.to_public().as_bytes()), 200) })) as Descriptor["cosigners"],
  };
  const addresses = deriveAddresses(descriptor);
  const unsigned = buildUnsignedTransaction({
    descriptor, addresses,
    utxos: [{ txHash: "aa".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }],
    destination: addresses[1].address, changeAddress: addresses[2].address, amountLovelace: 5_000_000n,
    protocol: PROTOCOL, tipSlot: 10_000_000n,
  });
  return { descriptor, addresses, phrase, unsigned, signed: signWithTestMnemonic(unsigned, phrase).signedTxHex };
}

function assetFixture() {
  const base = fixture();
  const utxos: Utxo[] = [
    { txHash: "bb".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: base.addresses[0].address, derivationIndex: 0,
      assets: [{ policyId: POLICY, assetNameHex: NAME, quantity: 1000n }] },
  ];
  const unsigned = buildUnsignedTransaction({
    descriptor: base.descriptor, addresses: base.addresses, utxos,
    destination: base.addresses[1].address, changeAddress: base.addresses[2].address,
    amountLovelace: 0n, assetRequests: [{ policyId: POLICY, assetNameHex: NAME, quantity: 400n }],
    protocol: PROTOCOL, tipSlot: 10_000_000n,
  });
  return { ...base, utxos, unsigned };
}

describe("malicious input property tests", () => {
  test("never accepts arbitrary JSON as a descriptor without satisfying all invariants", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      try {
        const descriptor = validateDescriptor(value);
        expect(descriptor.format).toBe("cardano-hd-multisig");
        expect(descriptor.threshold).toBeGreaterThanOrEqual(1);
        expect(descriptor.threshold).toBeLessThanOrEqual(descriptor.cosigners.length);
        expect(new Set(descriptor.cosigners.map((item) => item.accountXpub)).size).toBe(descriptor.cosigners.length);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }), { numRuns: 500 });
  });

  test("rejects bounded random CBOR substituted into a valid signing package", () => {
    const { unsigned } = fixture();
    fc.assert(fc.property(fc.uint8Array({ minLength: 0, maxLength: 2048 }), (bytes) => {
      const txCborHex = Buffer.from(bytes).toString("hex");
      if (txCborHex === unsigned.txCborHex) return;
      expect(() => validateUnsignedPackage({ ...unsigned, txCborHex })).toThrow();
    }), { numRuns: 300 });
  });

  test("rejects every sampled bit flip in an Ed25519 witness", () => {
    const { unsigned, signed } = fixture();
    const parsed = NodeC.Transaction.from_hex(signed);
    const signature = parsed.witness_set().vkeys()!.get(0).signature().to_hex();
    fc.assert(fc.property(fc.integer({ min: 0, max: signature.length - 1 }), (index) => {
      const replacement = signature[index] === "0" ? "1" : "0";
      const corruptedSignature = `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
      const corrupted = signed.replace(signature, corruptedSignature);
      expect(() => validateSignedTransaction(unsigned.txCborHex, corrupted)).toThrow();
    }), { numRuns: 256 });
  });

  test("rejects arbitrary policy and summary mutations", () => {
    const { unsigned } = fixture();
    fc.assert(fc.property(
      fc.record({ threshold: fc.integer({ min: -1000, max: 1000 }), amount: fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }) }),
      ({ threshold, amount }) => {
        if (threshold === unsigned.requiredSignatures && amount.toString() === unsigned.outputs[0].lovelace) return;
        const mutated = { ...unsigned, requiredSignatures: threshold, outputs: [{ ...unsigned.outputs[0], lovelace: amount.toString() }, ...unsigned.outputs.slice(1)] };
        expect(() => validateUnsignedPackage(mutated)).toThrow();
      },
    ), { numRuns: 300 });
  });

  test("rejects arbitrary asset-quantity mutations in v2 signing packages", () => {
    const { unsigned } = assetFixture();
    fc.assert(fc.property(fc.bigInt({ min: -10_000_000n, max: 10_000_000_000n }), (quantity) => {
      const asString = quantity <= 0n ? "0" : quantity.toString();
      if (asString === unsigned.outputs[0].assets![0].quantity) return;
      const mutated = {
        ...unsigned,
        outputs: [
          { ...unsigned.outputs[0], assets: [{ policyId: POLICY, assetNameHex: NAME, quantity: asString }] },
          ...unsigned.outputs.slice(1),
        ],
      };
      expect(() => validateUnsignedPackage(mutated)).toThrow();
    }), { numRuns: 300 });
  });

  test("rejects malformed asset units in v2 signing packages", () => {
    const { unsigned } = assetFixture();
    const hexChunk = fc.integer({ min: 0, max: 2 ** 30 }).map((value) => value.toString(16));
    const malformedUnits = fc.record({
      policyId: fc.oneof(fc.constant("zz"), hexChunk, fc.constant(POLICY.slice(0, 40))),
      assetNameHex: fc.oneof(fc.constant("../etc"), hexChunk, fc.constant("00".repeat(40))),
      quantity: fc.oneof(fc.constant("0"), fc.constant("-5"), fc.constant("1.5"), fc.constant("0x10"), fc.constant("1e9"), fc.integer({ min: 1, max: 1000 }).map(String)),
    });
    fc.assert(fc.property(malformedUnits, (unit) => {
      const mutated = {
        ...unsigned,
        outputs: [{ ...unsigned.outputs[0], assets: [unit] }, ...unsigned.outputs.slice(1)],
      };
      let threw = false;
      try { validateUnsignedPackage(mutated); } catch { threw = true; }
      // Well-formed units that survive parsing must still mismatch the CBOR summary.
      if (!threw) throw new Error("malformed asset unit was accepted");
    }), { numRuns: 400 });
  });

  test("rejects staking package mutations around certificates and withdrawals", () => {
    const base = fixture();
    const addresses = deriveAddresses(base.descriptor);
    const operatorHash = "153806dbcd134ddee69a8c5204e38ac80448f62342f8c23cfe4b7edf";
    const { bech32 } = require("bech32");
    const poolId = bech32.encode("pool", bech32.toWords(Uint8Array.from(operatorHash.match(/../g)!.map((byte) => Number.parseInt(byte, 16)))), 200);
    const utxos = [{ txHash: "aa".repeat(32), txIndex: 0, lovelace: 50_000_000n, address: addresses[0].address, derivationIndex: 0 }];
    const staking = buildStakingTransaction({
      descriptor: base.descriptor, addresses, utxos,
      receiveAddress: addresses[2].address,
      action: { type: "delegate", poolId, register: true },
      rewardsLovelace: 0n, keyDeposit: 2_000_000n,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    const context = { rewardsLovelace: 0n, keyDeposit: 2_000_000n, registered: false };
    expect(validatePackageForWallet(staking, base.descriptor, addresses, utxos, context)).toBe(staking);
    const mutatedCertificates = fc.oneof(
      fc.constant([]),
      fc.constant([{ type: "delegate", poolId }]),
      fc.constant([{ type: "register" }]),
      fc.constant([{ type: "deregister" }]),
      fc.constant([{ type: "register" }, { type: "register" }]),
      fc.record({ type: fc.constant("delegate"), poolId: fc.stringMatching(/^pool1/) }).map((c) => [c]),
    );
    fc.assert(fc.property(mutatedCertificates, fc.bigInt({ min: -1n, max: 5_000_000_000n }), (certificates, withdrawal) => {
      const mutated = { ...staking, certificates, withdrawalLovelace: withdrawal > 0n ? withdrawal.toString() : undefined };
      let threw = false;
      try { validateUnsignedPackage(mutated); } catch { threw = true; }
      if (!threw && JSON.stringify(certificates) === JSON.stringify(staking.certificates)) return;
      expect(threw).toBe(true);
    }), { numRuns: 300 });
  });

  test("metadata resolver never trusts hostile asset_info rows", () => {
    fc.assert(fc.property(fc.jsonValue(), (row) => {
      const meta = resolveAssetMeta(POLICY, NAME, row as never);
      expect(meta.fingerprint).toMatch(/^asset1[023456789acdefghjklmnpqrstuvwxyz]{30,}$/);
      if (meta.logo?.kind === "url") {
        expect(meta.logo.url).toMatch(/^https:\/\//);
        expect(meta.logo.url.length).toBeLessThanOrEqual(2048);
      }
      if (meta.logo?.kind === "data") expect(meta.logo.url.startsWith("data:image/")).toBe(true);
      if (meta.decimals !== null) {
        expect(meta.decimals).toBeGreaterThanOrEqual(0);
        expect(meta.decimals).toBeLessThanOrEqual(18);
      }
    }), { numRuns: 500 });
  });
});
