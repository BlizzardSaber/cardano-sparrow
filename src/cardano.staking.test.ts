import { describe, expect, test } from "vitest";
import * as NodeC from "@emurgo/cardano-serialization-lib-nodejs";
import { bech32 } from "bech32";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  buildStakingTransaction,
  deriveAddresses,
  deriveStakeScript,
  inspectFinalTransaction,
  mergeSignedTransactions,
  poolHashToBech32,
  poolIdToKeyHashHex,
  rewardAddressOf,
  validatePackageForWallet,
  validateUnsignedPackage,
} from "./cardano";
import { ledgerRequestFromPackage } from "./ledger";
import { signWithTestMnemonic } from "./test-signing";
import type { Descriptor, Utxo } from "./types";

const PROTOCOL = { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 };
const KEY_DEPOSIT = 2_000_000n;
// Real pool operator key hash, expressed as a bech32 pool id for the tests.
const OPERATOR_HASH = "153806dbcd134ddee69a8c5204e38ac80448f62342f8c23cfe4b7edf";
const POOL_ID = bech32.encode("pool", bech32.toWords(Uint8Array.from(OPERATOR_HASH.match(/../g)!.map((byte) => Number.parseInt(byte, 16)))), 200);

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

function utxoPool(addresses: ReturnType<typeof deriveAddresses>): Utxo[] {
  return [
    { txHash: "aa".repeat(32), txIndex: 0, lovelace: 50_000_000n, address: addresses[0].address, derivationIndex: 0 },
    { txHash: "bb".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[1].address, derivationIndex: 1 },
  ];
}

describe("staking derivation", () => {
  test("base addresses embed both payment and stake scripts", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    expect(addresses[0].address.startsWith("addr_test1")).toBe(true);
    const parsed = NodeC.BaseAddress.from_address(NodeC.Address.from_bech32(addresses[0].address));
    expect(parsed?.payment_cred().has_script_hash()).toBe(true);
    expect(parsed?.stake_cred().has_script_hash()).toBe(true);
    // Payment script differs per index; the stake script is shared.
    expect(addresses[0].scriptCborHex).not.toBe(addresses[1].scriptCborHex);
    expect(deriveStakeScript(descriptor).scriptCborHex).toBe(deriveStakeScript(descriptor).scriptCborHex);
  });

  test("reward address is a stake script address and mainnet differs from preprod", () => {
    const { descriptor } = fixture();
    expect(rewardAddressOf(descriptor).startsWith("stake_test1")).toBe(true);
    expect(rewardAddressOf({ ...descriptor, network: "mainnet" }).startsWith("stake1")).toBe(true);
  });

  test("pool ids round-trip between bech32 and operator key hash", () => {
    expect(poolIdToKeyHashHex(POOL_ID)).toBe(OPERATOR_HASH);
    expect(poolHashToBech32(OPERATOR_HASH)).toBe(POOL_ID);
    expect(() => poolIdToKeyHashHex("stake1abc")).toThrow(/质押池 ID/);
  });
});

describe("staking transactions", () => {
  test("first delegation registers the stake credential and pays the deposit", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "delegate", poolId: POOL_ID, register: true },
      rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });

    expect(pkg.version).toBe(3);
    expect(pkg.certificates).toEqual([{ type: "register" }, { type: "delegate", poolId: POOL_ID }]);
    expect(pkg.withdrawalLovelace).toBeUndefined();
    expect(pkg.signingPaths.at(-1)).toBe("m/1854'/1815'/0'/2/0");
    const ctx = { rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT, registered: false };
    expect(validatePackageForWallet(pkg, descriptor, addresses, utxos, ctx)).toBe(pkg);

    const tx = NodeC.Transaction.from_hex(pkg.txCborHex);
    const certs = tx.body().certs()!;
    expect(certs.len()).toBe(2);
    expect(certs.get(0).kind()).toBe(NodeC.CertificateKind.StakeRegistration);
    expect(certs.get(1).as_stake_delegation()!.pool_keyhash().to_hex()).toBe(OPERATOR_HASH);
    // Balance: inputs = output + fee + deposit.
    expect(BigInt(pkg.outputs[0].lovelace) + BigInt(pkg.feeLovelace) + KEY_DEPOSIT)
      .toBe(pkg.inputs.reduce((sum, input) => sum + utxos.find((u) => u.txHash === input.txHash)!.lovelace, 0n));
    // Witness set contains payment script and stake script.
    const scripts = tx.witness_set().native_scripts()!;
    expect(scripts.len()).toBeGreaterThanOrEqual(2);
  });

  test("rejects a package whose certificates target a foreign stake script", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos, receiveAddress: addresses[4].address,
      action: { type: "delegate", poolId: POOL_ID, register: true },
      rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    const original = NodeC.Transaction.from_hex(pkg.txCborHex);
    const body = original.body();
    const foreign = NodeC.Credential.from_scripthash(NodeC.ScriptHash.from_bytes(new Uint8Array(28).fill(9)));
    const certs = NodeC.Certificates.new();
    certs.add(NodeC.Certificate.new_stake_registration(NodeC.StakeRegistration.new(foreign)));
    certs.add(NodeC.Certificate.new_stake_delegation(NodeC.StakeDelegation.new(
      foreign, NodeC.Ed25519KeyHash.from_hex(OPERATOR_HASH),
    )));
    body.set_certs(certs);
    const poisoned = {
      ...pkg,
      txCborHex: NodeC.Transaction.new(body, original.witness_set()).to_hex(),
      txBodyHashHex: NodeC.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash().to_hex(),
    };
    expect(validateUnsignedPackage(poisoned)).toBe(poisoned);
    expect(() => validatePackageForWallet(poisoned, descriptor, addresses, utxos,
      { rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT, registered: false })).toThrow(/质押证书不属于当前钱包/);
  });

  test("pool change delegates without re-registering", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "delegate", poolId: POOL_ID, register: false },
      rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    expect(pkg.certificates).toEqual([{ type: "delegate", poolId: POOL_ID }]);
    const ctx = { rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT, registered: true };
    expect(validatePackageForWallet(pkg, descriptor, addresses, utxos, ctx)).toBe(pkg);
  });

  test("deregistration withdraws rewards and returns the deposit as a certificate refund", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const rewards = 12_345_678n;
    const withdraw = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "withdraw" },
      rewardsLovelace: rewards, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    expect(withdraw.certificates).toEqual([]);
    expect(withdraw.withdrawalLovelace).toBe(rewards.toString());
    expect(validatePackageForWallet(withdraw, descriptor, addresses, utxos, { rewardsLovelace: rewards, keyDeposit: KEY_DEPOSIT, registered: true })).toBe(withdraw);

    const dereg = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "deregister" },
      rewardsLovelace: rewards, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    expect(dereg.certificates).toEqual([{ type: "deregister" }]);
    expect(dereg.withdrawalLovelace).toBe(rewards.toString());
    const totalIn = dereg.inputs.reduce((sum, input) => sum + utxos.find((u) => u.txHash === input.txHash)!.lovelace, 0n);
    expect(BigInt(dereg.outputs[0].lovelace) + BigInt(dereg.feeLovelace))
      .toBe(totalIn + rewards + KEY_DEPOSIT);
    expect(validatePackageForWallet(dereg, descriptor, addresses, utxos, { rewardsLovelace: rewards, keyDeposit: KEY_DEPOSIT, registered: true })).toBe(dereg);
  });

  test("broadcast fee covers the final serialized staking transaction", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const linearFee = NodeC.LinearFee.new(NodeC.BigNum.from_str("44"), NodeC.BigNum.from_str("155381"));
    const action: Array<Parameters<typeof buildStakingTransaction>[0]["action"]> = [
      { type: "delegate", poolId: POOL_ID, register: true },
      { type: "delegate", poolId: POOL_ID, register: false },
      { type: "deregister" },
    ];
    for (const entry of action) {
      const pkg = buildStakingTransaction({
        descriptor, addresses, utxos,
        receiveAddress: addresses[4].address,
        action: entry,
        rewardsLovelace: 3_000_000n, keyDeposit: KEY_DEPOSIT,
        protocol: PROTOCOL, tipSlot: 10_000_000n,
      });
      const tx = NodeC.Transaction.from_hex(pkg.txCborHex);
      const scripts = tx.witness_set().native_scripts()!;
      const witnesses = NodeC.TransactionWitnessSet.new();
      witnesses.set_native_scripts(scripts);
      const vkeys = NodeC.Vkeywitnesses.new();
      const fake = NodeC.Ed25519Signature.from_bytes(new Uint8Array(64));
      const total = descriptor.threshold * scripts.len();
      for (let i = 0; i < total; i++) {
        vkeys.add(NodeC.Vkeywitness.new(NodeC.Vkey.new(NodeC.PublicKey.from_bytes(new Uint8Array(32).fill(1 + i))), fake));
      }
      witnesses.set_vkeys(vkeys);
      const minFee = BigInt(NodeC.min_fee(NodeC.Transaction.new(tx.body(), witnesses), linearFee).to_str());
      expect(BigInt(pkg.feeLovelace)).toBeGreaterThanOrEqual(minFee);
    }
  });

  test("signs with two devices, merges, and enforces threshold on both scripts", () => {
    const { descriptor, phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "delegate", poolId: POOL_ID, register: true },
      rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    const signed = phrases.slice(0, 2).map((phrase) => signWithTestMnemonic(pkg, phrase).signedTxHex);
    const merged = mergeSignedTransactions(pkg.txCborHex, signed);
    const final = inspectFinalTransaction(merged);
    expect(final.witnessCount).toBe(4); // 2 payment + 2 stake signatures
    expect(final.certificates).toEqual([{ type: "register" }, { type: "delegate", poolId: POOL_ID }]);
    expect(final.withdrawalLovelace).toBeNull();
    // A single signer is below threshold for either script.
    expect(() => mergeSignedTransactions(pkg.txCborHex, signed.slice(0, 1))).toThrow(/签名不足/);
  });

  test("reserves enough fee for all three 2-of-3 staking cosigners", () => {
    const { descriptor, phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos: utxoPool(addresses),
      receiveAddress: addresses[4].address,
      action: { type: "delegate", poolId: POOL_ID, register: true },
      rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    const signed = phrases.map((phrase) => signWithTestMnemonic(pkg, phrase).signedTxHex);
    const merged = NodeC.Transaction.from_hex(mergeSignedTransactions(pkg.txCborHex, signed));
    const linearFee = NodeC.LinearFee.new(NodeC.BigNum.from_str("44"), NodeC.BigNum.from_str("155381"));
    expect(merged.witness_set().vkeys()?.len()).toBe(6);
    expect(BigInt(merged.body().fee().to_str())).toBeGreaterThanOrEqual(BigInt(NodeC.min_fee(merged, linearFee).to_str()));
  });

  test("maps staking transactions into Ledger multisig mode with script credentials", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "deregister" },
      rewardsLovelace: 5_000_000n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    const request = ledgerRequestFromPackage(pkg);
    expect(request.signingMode).toBe("multisig_transaction");
    expect(request.tx.certificates).toHaveLength(1);
    expect(request.tx.certificates![0]).toMatchObject({ type: 1 }); // STAKE_DEREGISTRATION
    expect(request.tx.withdrawals).toHaveLength(1);
    const stakeScriptHash = deriveStakeScript(descriptor).credential.to_scripthash()!.to_hex();
    expect((request.tx.withdrawals![0] as { stakeCredential: { scriptHashHex?: string } }).stakeCredential.scriptHashHex).toBe(stakeScriptHash);
    expect(request.additionalWitnessPaths!.at(-1)).toEqual([0x8000073e, 0x80000717, 0x80000000, 2, 0]);
  });

  test("rejects malformed staking packages and inconsistent live state", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = utxoPool(addresses);
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "delegate", poolId: POOL_ID, register: true },
      rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    const ctx = { rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT, registered: false };
    // Already registered: re-registration refused.
    expect(() => validatePackageForWallet(pkg, descriptor, addresses, utxos, { ...ctx, registered: true })).toThrow(/已注册/);
    // Missing staking context refused.
    expect(() => validatePackageForWallet(pkg, descriptor, addresses, utxos)).toThrow(/缺少质押状态/);
    // Staking fields forbidden in non-v3 packages.
    expect(() => validateUnsignedPackage({ ...pkg, version: 1 })).toThrow();
    expect(() => validateUnsignedPackage({ ...pkg, version: 2 })).toThrow();
    // Tampered withdrawal amount mismatch.
    expect(() => validateUnsignedPackage({ ...pkg, withdrawalLovelace: "5" })).toThrow(/摘要与交易 CBOR 不一致/);
    // Duplicate stake path rejected.
    expect(() => validateUnsignedPackage({ ...pkg, signingPaths: [...pkg.signingPaths, "m/1854'/1815'/0'/2/0"] })).toThrow(/CIP-1854/);
    // v3 requires the stake script in the witness set (drop it by swapping scripts array is covered by wallet check below).
    expect(() => validatePackageForWallet({ ...pkg, certificates: [{ type: "delegate", poolId: POOL_ID }] }, descriptor, addresses, utxos, ctx)).toThrow(/摘要与交易 CBOR 不一致/);
  });

  test("pre-0.3.0 enterprise addresses are outside this wallet model", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    // An enterprise address has the same payment script but is not derived,
    // scanned, or accepted by this version.
    const enterprise = NodeC.EnterpriseAddress.new(
      0,
      NodeC.Credential.from_scripthash(
        NodeC.NativeScript.from_hex(addresses[0].scriptCborHex).hash(),
      ),
    ).to_address().to_bech32();
    const utxos: Utxo[] = [{ txHash: "cc".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: enterprise, derivationIndex: 0 }];
    const pkg = buildStakingTransaction({
      descriptor, addresses, utxos,
      receiveAddress: addresses[4].address,
      action: { type: "delegate", poolId: POOL_ID, register: false },
      rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT,
      protocol: PROTOCOL, tipSlot: 10_000_000n,
    });
    expect(() => validatePackageForWallet(pkg, descriptor, addresses, utxos, { rewardsLovelace: 0n, keyDeposit: KEY_DEPOSIT, registered: true }))
      .toThrow(/不属于当前钱包/);
  });
});
