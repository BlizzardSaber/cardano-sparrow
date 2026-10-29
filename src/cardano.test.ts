import { describe, expect, test, vi } from "vitest";
import * as NodeC from "@emurgo/cardano-serialization-lib-nodejs";
import { bech32 } from "bech32";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { addCip30WitnessSet, addLedgerWitnesses, buildUnsignedTransaction, deriveAddresses, inspectFinalTransaction, mergeSignedTransactions, transactionCborFromImport, transactionId, transactionTextEnvelope, unsignedPackageFromTransaction, validatePackageForWallet, validateSignedTransaction, validateUnsignedPackage } from "./cardano";
import { signWithTestMnemonic } from "./test-signing";
import { ledgerRequestFromPackage } from "./ledger";
import type { Descriptor, UnsignedPackage } from "./types";
import { broadcast } from "./provider";

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
    gapLimit: 3,
    cosigners: privateKeys.map((key, index) => ({
      name: `Signer ${index + 1}`,
      accountXpub: bech32.encode("acct_shared_xvk", bech32.toWords(key.to_public().as_bytes()), 200),
    })) as Descriptor["cosigners"],
  };
  return { phrases, descriptor };
}

describe("CIP-1854 multisig core", () => {
  test("accepts only a broadcast receipt matching the local transaction body", async () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const unsigned = buildUnsignedTransaction({
      descriptor, addresses,
      utxos: [{ txHash: "44".repeat(32), txIndex: 0, lovelace: 20_000_000n,
        assets: [], address: addresses[0].address, derivationIndex: 0 }],
      destination: addresses[1].address, amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 }, tipSlot: 10_000_000n,
    });
    const expected = transactionId(unsigned.txCborHex);
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(`"${expected}"`, { status: 200 })));
      await expect(broadcast(unsigned.txCborHex, "preprod")).resolves.toBe(expected);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(`"${"aa".repeat(32)}"`, { status: 200 })));
      await expect(broadcast(unsigned.txCborHex, "preprod")).rejects.toThrow(/交易 ID 与本地计算结果不一致/);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("OK", { status: 200 })));
      await expect(broadcast(unsigned.txCborHex, "preprod")).rejects.toThrow(/交易 ID 与本地计算结果不一致/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("derives deterministic, distinct 2-of-3 script addresses", () => {
    const { descriptor } = fixture();
    const first = deriveAddresses(descriptor);
    const second = deriveAddresses(descriptor);
    expect(first.map((x) => x.address)).toEqual(second.map((x) => x.address));
    expect(new Set(first.map((x) => x.address)).size).toBe(3);
    expect(first[0].address.startsWith("addr_test1")).toBe(true);
    expect(first[0].keyHashes).toHaveLength(3);
  });

  test("uses only the CIP-1854 role-0 path for inputs and change", () => {
    const { descriptor } = fixture();
    const receive = deriveAddresses(descriptor);
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses: receive,
      utxos: [{
        txHash: "44".repeat(32),
        txIndex: 0,
        lovelace: 20_000_000n,
        assets: [],
        address: receive[0].address,
        derivationIndex: 0,
      }],
      destination: receive[1].address,
      changeAddress: receive[2].address,
      amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 },
      tipSlot: 10_000_000n,
    });

    expect(unsigned.signingPaths).toEqual(["m/1854'/1815'/0'/0/0"]);
    expect(unsigned.outputs[1].address).toBe(receive[2].address);
    expect(validatePackageForWallet(unsigned, descriptor, receive, unsigned.inputs.map((input) => ({
      ...input,
      lovelace: 20_000_000n,
    })))).toBe(unsigned);
    expect(() => validateUnsignedPackage({
      ...unsigned,
      signingPaths: ["m/1854'/1815'/0'/1/0"],
      inputs: unsigned.inputs.map((input) => ({ ...input, derivationRole: 1 })),
    })).toThrow(/CIP-1854/);
  });

  test("exports Eternl text envelopes and safely rebuilds imports from live wallet data", () => {
    const { descriptor, phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [{ txHash: "45".repeat(32), txIndex: 1, lovelace: 20_000_000n,
      address: addresses[0].address, derivationIndex: 0 }];
    const unsigned = buildUnsignedTransaction({
      descriptor, addresses, utxos, destination: addresses[1].address,
      changeAddress: addresses[2].address, amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 }, tipSlot: 10_000_000n,
    });
    const envelope = transactionTextEnvelope(unsigned);
    expect(envelope).toMatchObject({ type: "Tx ConwayEra", cborHex: unsigned.txCborHex });
    expect(transactionId(envelope.cborHex)).toBe(unsigned.txBodyHashHex);

    const rebuilt = unsignedPackageFromTransaction(transactionCborFromImport(envelope), descriptor, addresses, utxos);
    expect(rebuilt).toEqual(unsigned);
    expect(validatePackageForWallet(rebuilt, descriptor, addresses, utxos)).toBe(rebuilt);
    expect(() => unsignedPackageFromTransaction(envelope.cborHex, descriptor, addresses, []))
      .toThrow(/未同步到的输入/);

    const signed = signWithTestMnemonic(unsigned, phrases[0]).signedTxHex;
    expect(transactionCborFromImport({ type: "Tx ConwayEra", cborHex: signed })).toBe(signed);
    expect(() => transactionCborFromImport({ type: "PaymentSigningKeyShelley_ed25519", cborHex: "5820" + "11".repeat(32) }))
      .toThrow();
  });

  test("supports configurable M-of-N policies", () => {
    const { descriptor } = fixture();
    const twoOfTwo = { ...descriptor, cosigners: descriptor.cosigners.slice(0, 2) };
    const threeOfThree = { ...descriptor, threshold: 3 };
    const twoScript = NodeC.NativeScript.from_hex(deriveAddresses(twoOfTwo)[0].scriptCborHex).as_script_n_of_k();
    const threeScript = NodeC.NativeScript.from_hex(deriveAddresses(threeOfThree)[0].scriptCborHex).as_script_n_of_k();
    expect(twoScript?.n()).toBe(2);
    expect(twoScript?.native_scripts().len()).toBe(2);
    expect(threeScript?.n()).toBe(3);
    expect(threeScript?.native_scripts().len()).toBe(3);
  });

  test("derives mainnet addresses and blocks the browser mnemonic signer", () => {
    const { descriptor, phrases } = fixture();
    const mainnet = { ...descriptor, network: "mainnet" as const };
    const addresses = deriveAddresses(mainnet);
    expect(addresses[0].address.startsWith("addr1")).toBe(true);
    const utxos = [{ txHash: "aa".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }];
    const unsigned = buildUnsignedTransaction({ descriptor: mainnet, addresses, utxos, destination: addresses[1].address, amountLovelace: 5_000_000n, protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 }, tipSlot: 10_000_000n });
    expect(NodeC.Transaction.from_hex(unsigned.txCborHex).body().network_id()?.kind()).toBe(NodeC.NetworkIdKind.Mainnet);
    expect(ledgerRequestFromPackage(unsigned).tx.network).toEqual({ networkId: 1, protocolMagic: 764824073 });
    expect(() => signWithTestMnemonic(unsigned, phrases[0])).toThrow(/主网禁用助记词软件签名/);
  });

  test("binds imported signing packages to the active wallet and live UTXOs", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [{ txHash: "bb".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }];
    const unsigned = buildUnsignedTransaction({ descriptor, addresses, utxos, destination: addresses[1].address, amountLovelace: 5_000_000n, protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 }, tipSlot: 10_000_000n });
    expect(validatePackageForWallet(unsigned, descriptor, addresses, utxos)).toBe(unsigned);
    expect(() => validatePackageForWallet(unsigned, descriptor, addresses, [])).toThrow(/不是当前钱包已同步的未花费输出/);
    expect(() => validatePackageForWallet({ ...unsigned, requiredSignatures: 3 }, descriptor, addresses, utxos)).toThrow(/阈值与当前钱包策略不一致/);
  });

  test("rejects imported packages without a TTL or outside the live slot window", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [{ txHash: "ba".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }];
    const unsigned = buildUnsignedTransaction({
      descriptor, addresses, utxos, destination: addresses[1].address,
      amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 }, tipSlot: 10_000_000n,
    });
    expect(validatePackageForWallet(unsigned, descriptor, addresses, utxos, undefined, 10_000_000n)).toBe(unsigned);
    expect(() => validatePackageForWallet(unsigned, descriptor, addresses, utxos, undefined, 10_003_600n)).toThrow(/有效期/);
    expect(() => validatePackageForWallet(unsigned, descriptor, addresses, utxos, undefined, 9_999_999n)).toThrow(/有效期/);

    const parsed = NodeC.Transaction.from_hex(unsigned.txCborHex);
    const originalBody = parsed.body();
    const withoutTtl = NodeC.TransactionBody.new_tx_body(originalBody.inputs(), originalBody.outputs(), originalBody.fee());
    withoutTtl.set_network_id(originalBody.network_id()!);
    const tx = NodeC.Transaction.new(withoutTtl, parsed.witness_set());
    const noTtlPackage = {
      ...unsigned,
      txCborHex: tx.to_hex(),
      txBodyHashHex: NodeC.FixedTransaction.new_from_body_bytes(withoutTtl.to_bytes()).transaction_hash().to_hex(),
    };
    expect(() => validateUnsignedPackage(noTtlPackage)).toThrow(/缺少交易有效期/);
    expect(() => validateUnsignedPackage({ ...unsigned, txCborHex: `${unsigned.txCborHex}ff` }))
      .toThrow(/非规范编码或包含额外数据/);
  });

  test("rejects an imported package that labels an outside address as change", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [{ txHash: "bc".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }];
    const original = buildUnsignedTransaction({
      descriptor, addresses, utxos, destination: addresses[1].address,
      changeAddress: addresses[2].address, amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 }, tipSlot: 10_000_000n,
    });
    const tx = NodeC.Transaction.from_hex(original.txCborHex);
    const oldBody = tx.body();
    const attacker = NodeC.EnterpriseAddress.new(0, NodeC.Credential.from_keyhash(
      NodeC.PublicKey.from_bytes(new Uint8Array(32).fill(9)).hash(),
    )).to_address();
    const outputs = NodeC.TransactionOutputs.new();
    outputs.add(oldBody.outputs().get(0));
    outputs.add(NodeC.TransactionOutput.new(attacker, oldBody.outputs().get(1).amount()));
    const body = NodeC.TransactionBody.new_tx_body(oldBody.inputs(), outputs, oldBody.fee());
    body.set_ttl(oldBody.ttl_bignum()!);
    body.set_network_id(oldBody.network_id()!);
    const poisoned = {
      ...original,
      txCborHex: NodeC.Transaction.new(body, tx.witness_set()).to_hex(),
      txBodyHashHex: NodeC.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash().to_hex(),
      outputs: [original.outputs[0], { ...original.outputs[1], address: attacker.to_bech32() }],
    };
    expect(validateUnsignedPackage(poisoned)).toEqual(poisoned);
    expect(() => validatePackageForWallet(poisoned, descriptor, addresses, utxos)).toThrow(/找零地址不属于/);
  });

  test("builds, signs twice, merges witnesses, and preserves transaction id", () => {
    const { descriptor, phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos: [{ txHash: "ab".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }],
      destination: addresses[1].address,
      changeAddress: addresses[2].address,
      amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 },
      tipSlot: 10_000_000n,
    });

    const beforeSigning = inspectFinalTransaction(unsigned.txCborHex);
    expect(beforeSigning).toMatchObject({
      txId: unsigned.txBodyHashHex,
      outputs: unsigned.outputs,
      feeLovelace: unsigned.feeLovelace,
      witnessCount: 0,
    });

    const signed = phrases.slice(0, 2).map((phrase) => signWithTestMnemonic(unsigned, phrase).signedTxHex);
    expect(validateSignedTransaction(unsigned.txCborHex, signed[0])).toMatchObject({ witnessCount: 1 });
    expect(() => validateSignedTransaction(unsigned.txCborHex, `${signed[0]}ff`)).toThrow(/包含额外数据/);
    expect(() => mergeSignedTransactions(unsigned.txCborHex, [`${signed[0]}ff`, signed[1]])).toThrow(/包含额外数据/);
    const merged = mergeSignedTransactions(unsigned.txCborHex, signed);
    const final = inspectFinalTransaction(merged);
    expect(() => inspectFinalTransaction(`${merged}ff`)).toThrow(/包含额外数据/);
    expect(unsigned.outputs[1].address).toBe(addresses[2].address);
    expect(NodeC.Transaction.from_hex(merged).witness_set().vkeys()?.len()).toBe(2);
    expect(transactionId(merged)).toBe(unsigned.txBodyHashHex);
    expect(final).toMatchObject({
      txId: unsigned.txBodyHashHex,
      inputCount: 1,
      outputs: unsigned.outputs,
      feeLovelace: unsigned.feeLovelace,
      witnessCount: 2,
    });
    expect(() => validateUnsignedPackage({ ...unsigned, outputs: [{ ...unsigned.outputs[0], lovelace: "1" }, unsigned.outputs[1]] }))
      .toThrow(/摘要与交易 CBOR 不一致/);
  });

  test("sends the maximum from all pure-ADA UTXOs with an exact fee and no change", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const utxos = [
      { txHash: "11".repeat(32), txIndex: 0, lovelace: 12_000_000n, address: addresses[0].address, derivationIndex: 0 },
      { txHash: "22".repeat(32), txIndex: 1, lovelace: 8_000_000n, address: addresses[1].address, derivationIndex: 1 },
    ];
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos,
      destination: addresses[2].address,
      amountLovelace: 0n,
      sendMax: true,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 },
      tipSlot: 10_000_000n,
    });

    expect(unsigned.inputs).toHaveLength(2);
    expect(unsigned.outputs).toHaveLength(1);
    expect(BigInt(unsigned.outputs[0].lovelace) + BigInt(unsigned.feeLovelace)).toBe(20_000_000n);
    expect(validatePackageForWallet(unsigned, descriptor, addresses, utxos)).toBe(unsigned);
  });

  test("maps the exact transaction to Ledger multisig mode and verifies its returned witness", () => {
    const { descriptor, phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos: [{ txHash: "ef".repeat(32), txIndex: 1, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }],
      destination: addresses[1].address,
      changeAddress: addresses[2].address,
      amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 },
      tipSlot: 10_000_000n,
    });
    const request = ledgerRequestFromPackage(unsigned);
    expect(request.signingMode).toBe("multisig_transaction");
    expect(request.tx.network).toEqual({ networkId: 0, protocolMagic: 1 });
    expect(request.tx.inputs[0]).toMatchObject({ txHashHex: "ef".repeat(32), outputIndex: 1, path: null });
    expect(request.tx.outputs.map((output) => String(output.amount))).toEqual(unsigned.outputs.map((output) => output.lovelace));
    expect(request.additionalWitnessPaths).toEqual([[0x8000073e, 0x80000717, 0x80000000, 0, 0]]);
    expect(request.options?.tagCborSets).toBe(true);
    expect(NodeC.Transaction.from_hex(unsigned.txCborHex).body().inputs().to_hex().startsWith("d90102")).toBe(true);

    const softwareSigned = NodeC.Transaction.from_hex(signWithTestMnemonic(unsigned, phrases[0]).signedTxHex);
    const signature = softwareSigned.witness_set().vkeys()!.get(0).signature().to_hex();
    const ledgerSigned = addLedgerWitnesses(unsigned, descriptor.cosigners[0].accountXpub, [{
      path: request.additionalWitnessPaths![0],
      witnessSignatureHex: signature,
    }]);
    expect(NodeC.Transaction.from_hex(ledgerSigned).witness_set().vkeys()?.len()).toBe(1);
    expect(transactionId(ledgerSigned)).toBe(unsigned.txBodyHashHex);
  });

  test("accepts only valid CIP-30 vkey witnesses for the original transaction", () => {
    const { descriptor, phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos: [{ txHash: "33".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }],
      destination: addresses[1].address,
      amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 },
      tipSlot: 10_000_000n,
    });
    const softwareSigned = NodeC.Transaction.from_hex(signWithTestMnemonic(unsigned, phrases[0]).signedTxHex);
    const returned = NodeC.TransactionWitnessSet.new();
    returned.set_vkeys(softwareSigned.witness_set().vkeys()!);

    const signed = addCip30WitnessSet(unsigned, returned.to_hex());
    expect(validateSignedTransaction(unsigned.txCborHex, signed).witnessCount).toBe(1);
    expect(transactionId(signed)).toBe(unsigned.txBodyHashHex);
    expect(() => addCip30WitnessSet(unsigned, softwareSigned.witness_set().to_hex())).toThrow(/非预期的非 VKey/);
  });

  test("broadcast fee covers the final serialized transaction for every flow", () => {
    const { descriptor } = fixture();
    const addresses = deriveAddresses(descriptor);
    const linearFee = NodeC.LinearFee.new(NodeC.BigNum.from_str("44"), NodeC.BigNum.from_str("155381"));
    const utxos = [
      { txHash: "11".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 },
      { txHash: "22".repeat(32), txIndex: 1, lovelace: 8_000_000n, address: addresses[1].address, derivationIndex: 1 },
    ];
    const minFeeWithRealWitnesses = (unsigned: UnsignedPackage) => {
      const tx = NodeC.Transaction.from_hex(unsigned.txCborHex);
      const scripts = tx.witness_set().native_scripts()!;
      const witnesses = NodeC.TransactionWitnessSet.new();
      witnesses.set_native_scripts(scripts);
      const vkeys = NodeC.Vkeywitnesses.new();
      const fake = NodeC.Ed25519Signature.from_bytes(new Uint8Array(64));
      const total = unsigned.requiredSignatures * scripts.len();
      for (let i = 0; i < total; i++) {
        vkeys.add(NodeC.Vkeywitness.new(NodeC.Vkey.new(NodeC.PublicKey.from_bytes(new Uint8Array(32).fill(1 + i))), fake));
      }
      witnesses.set_vkeys(vkeys);
      return BigInt(NodeC.min_fee(NodeC.Transaction.new(tx.body(), witnesses), linearFee).to_str());
    };
    for (const sendMax of [false, true]) {
      const unsigned = buildUnsignedTransaction({
        descriptor, addresses, utxos,
        destination: addresses[2].address,
        amountLovelace: 5_000_000n,
        sendMax,
        protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 },
        tipSlot: 10_000_000n,
      });
      expect(BigInt(unsigned.feeLovelace)).toBeGreaterThanOrEqual(minFeeWithRealWitnesses(unsigned));
    }
  });

  test("refuses to finalize a 3-of-3 transaction with only two witnesses", () => {
    const { descriptor: base, phrases } = fixture();
    const descriptor = { ...base, threshold: 3 };
    const addresses = deriveAddresses(descriptor);
    const unsigned = buildUnsignedTransaction({
      descriptor,
      addresses,
      utxos: [{ txHash: "cd".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }],
      destination: addresses[1].address,
      amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 },
      tipSlot: 10_000_000n,
    });
    const signed = phrases.map((phrase) => signWithTestMnemonic(unsigned, phrase).signedTxHex);
    expect(() => mergeSignedTransactions(unsigned.txCborHex, signed.slice(0, 2))).toThrow(/签名不足/);
    expect(NodeC.Transaction.from_hex(mergeSignedTransactions(unsigned.txCborHex, signed)).witness_set().vkeys()?.len()).toBe(3);
  });

  test("reserves enough fee when all three cosigners sign a 2-of-3 transaction", () => {
    const { descriptor, phrases } = fixture();
    const addresses = deriveAddresses(descriptor);
    const unsigned = buildUnsignedTransaction({
      descriptor, addresses,
      utxos: [{ txHash: "ee".repeat(32), txIndex: 0, lovelace: 20_000_000n, address: addresses[0].address, derivationIndex: 0 }],
      destination: addresses[1].address, changeAddress: addresses[2].address,
      amountLovelace: 5_000_000n,
      protocol: { txFeePerByte: 44, txFeeFixed: 155381, utxoCostPerByte: 4310 }, tipSlot: 10_000_000n,
    });
    const signed = phrases.map((phrase) => signWithTestMnemonic(unsigned, phrase).signedTxHex);
    const merged = NodeC.Transaction.from_hex(mergeSignedTransactions(unsigned.txCborHex, signed));
    const linearFee = NodeC.LinearFee.new(NodeC.BigNum.from_str("44"), NodeC.BigNum.from_str("155381"));
    expect(merged.witness_set().vkeys()?.len()).toBe(3);
    expect(BigInt(merged.body().fee().to_str())).toBeGreaterThanOrEqual(BigInt(NodeC.min_fee(merged, linearFee).to_str()));
  });
});
