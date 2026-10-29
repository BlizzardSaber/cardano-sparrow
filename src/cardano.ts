import * as C from "@emurgo/cardano-serialization-lib-browser";
import { bech32 } from "bech32";
import type { AssetQuantity, AssetUnit, DerivedAddress, Descriptor, StakingCertificate, UnsignedPackage, Utxo } from "./types";
import { networkConfig } from "./network";
import { bytesToHex, hexToBytes } from "./fingerprint";

const HARDENED = 0x80000000;
const MAX_PACKAGE_ASSET_UNITS = 64;
const ADA_SELECTION_BUFFER = 2_000_000n;
const TX_TTL_SLOTS = 3600n;

export function validateDescriptor(value: unknown): Descriptor {
  const d = value as Partial<Descriptor>;
  if (d?.format !== "cardano-hd-multisig" || d.version !== 1 || !d.network || !["mainnet", "preprod"].includes(d.network))
    throw new Error("不是受支持的钱包描述文件");
  if (d.account !== 0 || !Number.isInteger(d.gapLimit) || d.gapLimit! < 1 || d.gapLimit! > 100)
    throw new Error("当前仅支持 account 0 和 1–100 个地址");
  if (!Array.isArray(d.cosigners) || d.cosigners.length < 1 || d.cosigners.length > 10)
    throw new Error("Cosigner 数量必须在 1–10 之间");
  if (!Number.isInteger(d.threshold) || d.threshold! < 1 || d.threshold! > d.cosigners.length)
    throw new Error("签名阈值必须在 1 与 cosigner 数量之间");

  const seen = new Set<string>();
  for (const signer of d.cosigners) {
    if (!signer?.name?.trim()) throw new Error("Cosigner 名称不能为空");
    if (!signer.accountXpub?.startsWith("acct_shared_xvk1")) throw new Error("公钥必须是 acct_shared_xvk 格式");
    try {
      accountPublicKey(signer.accountXpub);
    } catch {
      throw new Error(`${signer.name} 的 acct_shared_xvk 无效`);
    }
    if (seen.has(signer.accountXpub)) throw new Error("cosigner 公钥必须互不相同");
    seen.add(signer.accountXpub);
  }
  return d as Descriptor;
}

// Multisig stake policy: the same M-of-N template over role-2 keys at index 0
// (m/1854'/1815'/0'/2/0). CIP-1854 defines role 2 as stake keys; this
// application's fixed index and M-of-N delegation template must be preserved
// in the descriptor for another implementation to reconstruct the wallet.
export function deriveStakeScript(descriptor: Descriptor) {
  const scripts = C.NativeScripts.new();
  const hashes: string[] = [];
  for (const cosigner of descriptor.cosigners) {
    const keyHash = accountPublicKey(cosigner.accountXpub).derive(2).derive(0).to_raw_key().hash();
    hashes.push(keyHash.to_hex());
    scripts.add(C.NativeScript.new_script_pubkey(C.ScriptPubkey.new(keyHash)));
  }
  const script = C.NativeScript.new_script_n_of_k(C.ScriptNOfK.new(descriptor.threshold, scripts));
  return { scriptCborHex: script.to_hex(), keyHashes: hashes, credential: C.Credential.from_scripthash(script.hash()), script };
}

export function rewardAddressOf(descriptor: Descriptor): string {
  return C.RewardAddress.new(networkConfig(descriptor.network).networkId, deriveStakeScript(descriptor).credential)
    .to_address().to_bech32();
}

function paymentScript(descriptor: Descriptor, index: number) {
  const scripts = C.NativeScripts.new();
  const hashes: string[] = [];
  for (const cosigner of descriptor.cosigners) {
    const keyHash = accountPublicKey(cosigner.accountXpub).derive(0).derive(index).to_raw_key().hash();
    hashes.push(keyHash.to_hex());
    scripts.add(C.NativeScript.new_script_pubkey(C.ScriptPubkey.new(keyHash)));
  }
  return { script: C.NativeScript.new_script_n_of_k(C.ScriptNOfK.new(descriptor.threshold, scripts)), keyHashes: hashes };
}

// Base address: payment script + stake script. Only funds at base addresses
// count toward the delegated stake.
export function deriveAddress(descriptor: Descriptor, index: number): DerivedAddress {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error("派生序号超出 soft derivation 范围");
  const payment = paymentScript(descriptor, index);
  const stake = deriveStakeScript(descriptor);
  const address = C.BaseAddress.new(
    networkConfig(descriptor.network).networkId,
    C.Credential.from_scripthash(payment.script.hash()),
    stake.credential,
  ).to_address();
  return {
    index,
    address: address.to_bech32(),
    scriptCborHex: payment.script.to_hex(),
    keyHashes: payment.keyHashes,
  };
}

export function deriveAddresses(descriptor: Descriptor): DerivedAddress[] {
  return Array.from({ length: descriptor.gapLimit }, (_, index) => deriveAddress(descriptor, index));
}

type Protocol = { txFeePerByte: number; txFeeFixed: number; utxoCostPerByte: number };

const unitKey = (policyId: string, assetNameHex: string) => `${policyId}.${assetNameHex}`;

function toAssetMap(assets: AssetUnit[]): Map<string, AssetUnit> {
  const map = new Map<string, AssetUnit>();
  for (const asset of assets) {
    const key = unitKey(asset.policyId, asset.assetNameHex);
    const existing = map.get(key);
    if (existing) existing.quantity += asset.quantity;
    else map.set(key, { ...asset });
  }
  return map;
}

function sortedAssetUnits(map: Map<string, AssetUnit>): AssetUnit[] {
  return [...map.values()].filter((asset) => asset.quantity > 0n)
    .sort((a, b) => (a.policyId + a.assetNameHex < b.policyId + b.assetNameHex ? -1 : 1));
}

function buildValue(coin: bigint, assets: AssetUnit[]): C.Value {
  if (!assets.length) return C.Value.new(C.BigNum.from_str(coin.toString()));
  const multiAsset = C.MultiAsset.new();
  const byPolicy = new Map<string, AssetUnit[]>();
  for (const asset of assets) {
    const group = byPolicy.get(asset.policyId) ?? [];
    group.push(asset);
    byPolicy.set(asset.policyId, group);
  }
  // Canonical CBOR requires sorted policy and asset-name keys.
  for (const [policyId, group] of [...byPolicy.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const names = C.Assets.new();
    for (const asset of [...group].sort((a, b) => (a.assetNameHex < b.assetNameHex ? -1 : 1))) {
      names.insert(C.AssetName.new(hexToBytes(asset.assetNameHex)), C.BigNum.from_str(asset.quantity.toString()));
    }
    multiAsset.insert(C.ScriptHash.from_bytes(hexToBytes(policyId)), names);
  }
  return C.Value.new_with_assets(C.BigNum.from_str(coin.toString()), multiAsset);
}

function readAssetQuantities(value: C.Value): AssetQuantity[] {
  const multiAsset = value.multiasset();
  if (!multiAsset) return [];
  const result: AssetQuantity[] = [];
  const policies = multiAsset.keys();
  for (let i = 0; i < policies.len(); i++) {
    const policy = policies.get(i);
    const policyId = bytesToHex(policy.to_bytes());
    const assets = multiAsset.get(policy)!;
    const names = assets.keys();
    for (let j = 0; j < names.len(); j++) {
      const name = names.get(j);
      result.push({ policyId, assetNameHex: bytesToHex(name.name()), quantity: assets.get(name)!.to_str() });
    }
  }
  return result.sort((a, b) => (a.policyId + a.assetNameHex < b.policyId + b.assetNameHex ? -1 : 1));
}

function minAdaFor(output: C.TransactionOutput, dataCost: C.DataCost): bigint {
  return BigInt(C.min_ada_for_output(output, dataCost).to_str());
}

function assetQuantity(asset: AssetUnit): AssetQuantity {
  return { policyId: asset.policyId, assetNameHex: asset.assetNameHex, quantity: asset.quantity.toString() };
}

type DerivationRef = { index: number };
const addressFor = (addresses: DerivedAddress[], ref: DerivationRef) => addresses.find((item) => item.index === ref.index);

function scriptWitnesses(addresses: DerivedAddress[], refs: DerivationRef[]) {
  const scripts = C.NativeScripts.new();
  for (const ref of refs) {
    const address = addressFor(addresses, ref);
    if (!address) throw new Error(`找不到派生地址 0/${ref.index}`);
    scripts.add(C.NativeScript.from_hex(address.scriptCborHex));
  }
  return scripts;
}

function fakeVkeyWitnesses(descriptor: Descriptor, refs: DerivationRef[]) {
  const witnesses = C.Vkeywitnesses.new();
  const fakeSignature = C.Ed25519Signature.from_bytes(new Uint8Array(64));
  for (const { index } of refs) {
    for (const signer of descriptor.cosigners) {
      const publicKey = accountPublicKey(signer.accountXpub).derive(0).derive(index).to_raw_key();
      witnesses.add(C.Vkeywitness.new(C.Vkey.new(publicKey), fakeSignature));
    }
  }
  return witnesses;
}

export type AssetRequest = { policyId: string; assetNameHex: string; quantity: bigint };

const assetsOf = (utxo: Utxo): AssetUnit[] => utxo.assets ?? [];

// Greedy selection: cover every requested asset unit first (largest holders first),
// then top up with pure-ADA UTXOs for the payment, fee, and change minimums.
function selectUtxos(utxos: Utxo[], amountLovelace: bigint, requests: AssetRequest[]): Utxo[] {
  const selected: Utxo[] = [];
  const chosen = new Set<string>();
  const take = (utxo: Utxo) => {
    const key = `${utxo.txHash}#${utxo.txIndex}`;
    if (chosen.has(key)) return;
    chosen.add(key);
    selected.push(utxo);
  };

  for (const request of requests) {
    if (!/^[0-9a-f]{56}$/i.test(request.policyId) || !/^[0-9a-f]{0,64}$/i.test(request.assetNameHex))
      throw new Error("资产请求的 policy 或名称格式无效");
    const holders = utxos
      .map((utxo) => ({ utxo, quantity: assetsOf(utxo).find((asset) => unitKey(asset.policyId, asset.assetNameHex) === unitKey(request.policyId, request.assetNameHex))?.quantity ?? 0n }))
      .filter((entry) => entry.quantity > 0n)
      .sort((a, b) => (a.quantity > b.quantity ? -1 : 1));
    let covered = 0n;
    for (const holder of holders) {
      if (covered >= request.quantity) break;
      take(holder.utxo);
      covered += holder.quantity;
    }
    if (covered < request.quantity) throw new Error("资产余额不足");
  }

  const pureAda = utxos.filter((utxo) => !assetsOf(utxo).length).sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1));
  const selectedTotal = () => selected.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
  for (const utxo of pureAda) {
    if (selectedTotal() >= amountLovelace + ADA_SELECTION_BUFFER) break;
    take(utxo);
  }
  return selected;
}

export function buildUnsignedTransaction(args: {
  descriptor: Descriptor;
  addresses: DerivedAddress[];
  utxos: Utxo[];
  destination: string;
  amountLovelace: bigint;
  assetRequests?: AssetRequest[];
  protocol: Protocol;
  tipSlot: bigint;
  changeAddress?: string;
  sendMax?: boolean;
}): UnsignedPackage {
  const { descriptor, addresses, destination, amountLovelace, protocol, tipSlot } = args;
  const requests = args.assetRequests ?? [];
  if (requests.some((request) => request.quantity <= 0n)) throw new Error("资产发送数量必须大于零");
  const requestedUnits = new Set<string>();
  for (const request of requests) {
    const key = unitKey(request.policyId, request.assetNameHex);
    if (requestedUnits.has(key)) throw new Error("同一资产只能在一笔交易中请求一次");
    requestedUnits.add(key);
  }
  if (args.sendMax && requests.length) throw new Error("发送最大 ADA 与资产发送不能同时使用");
  const tokenMode = requests.length > 0;
  const sendMaxAdaOnly = !!args.sendMax;
  const destinationAddress = C.Address.from_bech32(destination);
  const networkId = networkConfig(descriptor.network).networkId;
  if (destinationAddress.network_id() !== networkId) throw new Error("收款地址与钱包网络不一致");
  if (destinationAddress.payment_cred()?.has_script_hash() && !addresses.some((item) => item.address === destination))
    throw new Error("当前不支持向未知脚本地址付款（需要 Datum 支持）");

  const candidateUtxos = tokenMode ? args.utxos : args.utxos.filter((utxo) => !assetsOf(utxo).length);
  if (!tokenMode && !candidateUtxos.length) throw new Error("没有可花费的纯 ADA UTXO");
  const selected = tokenMode
    ? selectUtxos(args.utxos, amountLovelace, requests)
    : (args.sendMax
      ? candidateUtxos
      : (() => {
          const chosen: Utxo[] = [];
          let total = 0n;
          for (const utxo of [...candidateUtxos].sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1))) {
            chosen.push(utxo);
            total += utxo.lovelace;
            if (!args.sendMax && total >= amountLovelace + ADA_SELECTION_BUFFER) break;
          }
          if (!args.sendMax && total < amountLovelace + 1_000_000n) throw new Error("余额不足，至少需预留约 1 ADA 作为找零和手续费");
          return chosen;
        })());
  if (!selected.length) throw new Error(tokenMode ? "资产余额不足" : "没有可花费的纯 ADA UTXO");

  const heldAssets = toAssetMap(selected.flatMap(assetsOf));
  const paymentAssets: AssetUnit[] = [];
  const changeAssets = toAssetMap(selected.flatMap(assetsOf));
  for (const request of requests) {
    const key = unitKey(request.policyId, request.assetNameHex);
    const held = heldAssets.get(key);
    if (!held || held.quantity < request.quantity) throw new Error("资产余额不足");
    changeAssets.get(key)!.quantity -= request.quantity;
    paymentAssets.push({ policyId: request.policyId, assetNameHex: request.assetNameHex, quantity: request.quantity });
  }
  const changeAssetList = sortedAssetUnits(changeAssets);

  const changeAddress = sendMaxAdaOnly ? undefined : args.changeAddress ?? addresses[0]?.address;
  const derivedChange = changeAddress ? addresses.find((item) => item.address === changeAddress) : undefined;
  if (changeAddress && !derivedChange) throw new Error("找零地址不属于当前多签钱包");
  if (changeAddress && C.Address.from_bech32(changeAddress).network_id() !== networkId) throw new Error("找零地址与钱包网络不一致");
  if (!sendMaxAdaOnly && !changeAddress) throw new Error("余额不足以支付金额和手续费");

  const inputs = C.TransactionInputs.new();
  for (const u of selected) inputs.add(C.TransactionInput.new(C.TransactionHash.from_hex(u.txHash), u.txIndex));
  const totalAda = selected.reduce((sum, u) => sum + u.lovelace, 0n);
  const linearFee = C.LinearFee.new(C.BigNum.from_str(String(protocol.txFeePerByte)), C.BigNum.from_str(String(protocol.txFeeFixed)));
  const dataCost = C.DataCost.new_coins_per_byte(C.BigNum.from_str(String(protocol.utxoCostPerByte)));
  const refs = [...new Map(selected.map((u) => {
    const ref = { index: u.derivationIndex } as DerivationRef;
    return [String(ref.index), ref] as const;
  })).values()].sort((a, b) => a.index - b.index);

  const assemble = (paymentAda: bigint, changeAda: bigint | undefined, fee: bigint) => {
    const outputs = C.TransactionOutputs.new();
    outputs.add(C.TransactionOutput.new(destinationAddress, buildValue(paymentAda, paymentAssets)));
    if (changeAda !== undefined) outputs.add(C.TransactionOutput.new(C.Address.from_bech32(changeAddress!), buildValue(changeAda, changeAssetList)));
    const body = C.TransactionBody.new_tx_body(inputs, outputs, C.BigNum.from_str(fee.toString()));
    body.set_ttl(C.BigNum.from_str((tipSlot + TX_TTL_SLOTS).toString()));
    body.set_network_id(descriptor.network === "mainnet" ? C.NetworkId.mainnet() : C.NetworkId.testnet());
    return body;
  };
  const estimateFee = (body: C.TransactionBody) => {
    const estimateWitnesses = C.TransactionWitnessSet.new();
    estimateWitnesses.set_native_scripts(scriptWitnesses(addresses, refs));
    estimateWitnesses.set_vkeys(fakeVkeyWitnesses(descriptor, refs));
    return BigInt(C.min_fee(C.Transaction.new(body, estimateWitnesses), linearFee).to_str());
  };
  const minPureChange = sendMaxAdaOnly || !changeAddress ? 0n : BigInt(C.min_ada_for_output(
    C.TransactionOutput.new(C.Address.from_bech32(changeAddress!), C.Value.new(C.BigNum.from_str("1000000"))),
    dataCost,
  ).to_str());

  // Fixed-point loop over fee-bearing bodies: the fee field's own CBOR width is
  // part of the transaction size, so min_fee must be evaluated on a body that
  // already carries the current fee. Iterate until the serialized body settles.
  let paymentAda = sendMaxAdaOnly ? totalAda : amountLovelace;
  let changeAda: bigint | undefined = sendMaxAdaOnly ? undefined : 0n;
  let fee = 0n;
  let body = assemble(paymentAda, changeAda, fee);
  let lastHex = "";
  for (let iteration = 0; iteration < 8; iteration++) {
    fee = estimateFee(body);
    if (sendMaxAdaOnly) {
      if (totalAda <= fee) throw new Error("余额不足以支付金额和手续费");
      paymentAda = totalAda - fee;
      changeAda = undefined;
    } else {
      const minPayment = minAdaFor(body.outputs().get(0), dataCost);
      const pay = tokenMode && amountLovelace < minPayment ? minPayment : amountLovelace;
      if (!tokenMode && pay < minPayment) throw new Error(`发送金额低于链上最小值（${minPayment.toString()} lovelace）`);
      const leftover = totalAda - fee - pay;
      if (changeAssetList.length) {
        const minChange = minAdaFor(body.outputs().get(body.outputs().len() - 1), dataCost);
        if (leftover < minChange) throw new Error(`找零低于链上最小值（${minChange.toString()} lovelace），请补充 ADA 或减少发送数量`);
        paymentAda = pay;
        changeAda = leftover;
      } else if (leftover >= minPureChange) {
        paymentAda = pay;
        changeAda = leftover;
      } else if (leftover < 0n) {
        throw new Error("余额不足以支付金额和手续费");
      } else if (tokenMode) {
        // No asset change forces an output, so a sub-minimum ADA remainder rides
        // along with the payment instead of creating an unspendable dust output.
        paymentAda = pay + leftover;
        changeAda = undefined;
      } else {
        throw new Error(`找零低于链上最小值（${minPureChange.toString()} lovelace），请调整发送金额`);
      }
    }
    body = assemble(paymentAda, changeAda, fee);
    const hex = body.to_hex();
    if (hex === lastHex) break;
    lastHex = hex;
    if (iteration === 7) throw new Error("手续费估算未收敛，请重试");
  }

  const outputsSummary: UnsignedPackage["outputs"] = [{ address: destination, lovelace: paymentAda.toString() }];
  if (changeAda !== undefined) outputsSummary.push({ address: changeAddress!, lovelace: changeAda.toString() });
  const paymentAssetList = sortedAssetUnits(toAssetMap(paymentAssets));
  if (paymentAssetList.length) outputsSummary[0].assets = paymentAssetList.map(assetQuantity);
  if (changeAda !== undefined && changeAssetList.length) outputsSummary[1].assets = changeAssetList.map(assetQuantity);

  const witnessSet = C.TransactionWitnessSet.new();
  witnessSet.set_native_scripts(scriptWitnesses(addresses, refs));
  const tx = C.Transaction.new(body, witnessSet);
  const hash = C.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash().to_hex();
  const hasAssets = paymentAssetList.length > 0 || changeAssetList.length > 0;

  return {
    format: "cardano-hd-multisig-tx",
    version: hasAssets ? 2 : 1,
    network: descriptor.network,
    txCborHex: tx.to_hex(),
    txBodyHashHex: hash,
    inputs: selected.map(({ txHash, txIndex, address, derivationIndex }) => ({ txHash, txIndex, address, derivationIndex })),
    outputs: outputsSummary,
    feeLovelace: fee.toString(),
    requiredSignatures: descriptor.threshold,
    signingPaths: refs.map(({ index }) => `m/1854'/1815'/0'/0/${index}`),
  };
}

export const STAKE_SIGNING_PATH = "m/1854'/1815'/0'/2/0";

export function poolIdToKeyHashHex(poolId: string): string {
  let decoded;
  try {
    decoded = bech32.decode(poolId.trim(), 200);
  } catch {
    throw new Error("质押池 ID 必须是 pool1 开头的 bech32 格式");
  }
  if (decoded.prefix !== "pool") throw new Error("质押池 ID 必须是 pool1 开头的 bech32 格式");
  const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
  if (bytes.length !== 28) throw new Error("质押池 ID 必须解码为 28 字节");
  return bytesToHex(bytes);
}

export type StakingAction =
  | { type: "delegate"; poolId: string; register: boolean }
  | { type: "withdraw" }
  | { type: "deregister" };

// Staking transactions reuse the payment-script UTXOs for fee/deposit funding and
// add certificates and (for withdrawals) a reward-account entry signed by the
// stake script. A single output returns the remaining ADA to the wallet.
export function buildStakingTransaction(args: {
  descriptor: Descriptor;
  addresses: DerivedAddress[];
  utxos: Utxo[];
  receiveAddress: string;
  action: StakingAction;
  rewardsLovelace: bigint;
  keyDeposit: bigint;
  protocol: Protocol;
  tipSlot: bigint;
}): UnsignedPackage {
  const { descriptor, addresses, protocol, tipSlot, action } = args;
  const networkId = networkConfig(descriptor.network).networkId;
  const stake = deriveStakeScript(descriptor);
  const receiveAddress = C.Address.from_bech32(args.receiveAddress);
  if (receiveAddress.network_id() !== networkId) throw new Error("收款地址与钱包网络不一致");
  const derivedReceive = addresses.find((item) => item.address === args.receiveAddress);
  if (!derivedReceive) throw new Error("找零地址不属于当前多签钱包");

  const poolHex = action.type === "delegate" ? poolIdToKeyHashHex(action.poolId) : null;
  const withdrawal = action.type === "withdraw" || action.type === "deregister" ? args.rewardsLovelace : 0n;
  const refund = action.type === "deregister" ? args.keyDeposit : 0n;
  if (action.type === "withdraw" && withdrawal <= 0n) throw new Error("当前没有可提取的奖励");

  // Staking transactions stay pure-ADA: asset UTXOs are never selected.
  const candidates = args.utxos.filter((utxo) => !assetsOf(utxo).length);
  if (!candidates.length) throw new Error("没有可花费的纯 ADA UTXO");
  const selected: Utxo[] = [];
  let totalIn = 0n;
  const registrationDeposit = action.type === "delegate" && action.register ? args.keyDeposit : 0n;
  const linearFee = C.LinearFee.new(C.BigNum.from_str(String(protocol.txFeePerByte)), C.BigNum.from_str(String(protocol.txFeeFixed)));
  const dataCost = C.DataCost.new_coins_per_byte(C.BigNum.from_str(String(protocol.utxoCostPerByte)));
  const stakeRef = { index: 0 } as const;

  const certs = C.Certificates.new();
  if (action.type === "delegate") {
    if (action.register) certs.add(C.Certificate.new_stake_registration(C.StakeRegistration.new(stake.credential)));
    certs.add(C.Certificate.new_stake_delegation(C.StakeDelegation.new(
      stake.credential,
      C.Ed25519KeyHash.from_bytes(hexToBytes(poolHex!)),
    )));
  } else if (action.type === "deregister") {
    certs.add(C.Certificate.new_stake_deregistration(C.StakeDeregistration.new(stake.credential)));
  }

  const withdrawals = C.Withdrawals.new();
  if (withdrawal > 0n) {
    withdrawals.insert(C.RewardAddress.new(networkId, stake.credential), C.BigNum.from_str(withdrawal.toString()));
  }

  const assemble = (outputLovelace: bigint, fee: bigint) => {
    const inputs = C.TransactionInputs.new();
    for (const u of selected) inputs.add(C.TransactionInput.new(C.TransactionHash.from_hex(u.txHash), u.txIndex));
    const outputs = C.TransactionOutputs.new();
    outputs.add(C.TransactionOutput.new(receiveAddress, C.Value.new(C.BigNum.from_str(outputLovelace.toString()))));
    const body = C.TransactionBody.new_tx_body(inputs, outputs, C.BigNum.from_str(fee.toString()));
    if (certs.len()) body.set_certs(certs);
    if (withdrawal > 0n) body.set_withdrawals(withdrawals);
    body.set_ttl(C.BigNum.from_str((tipSlot + TX_TTL_SLOTS).toString()));
    body.set_network_id(descriptor.network === "mainnet" ? C.NetworkId.mainnet() : C.NetworkId.testnet());
    return body;
  };
  const refsOf = () => [...new Map(selected.map((u) => {
    const ref = { index: u.derivationIndex } as DerivationRef;
    return [String(ref.index), ref] as const;
  })).values()].sort((a, b) => a.index - b.index);
  const scriptWitnessSet = (refs: DerivationRef[]) => {
    const witnessSet = C.TransactionWitnessSet.new();
    const scripts = C.NativeScripts.new();
    for (const ref of refs) {
      const address = addressFor(addresses, ref);
      if (!address) throw new Error(`找不到派生地址 0/${ref.index}`);
      scripts.add(C.NativeScript.from_hex(address.scriptCborHex));
    }
    scripts.add(C.NativeScript.from_hex(stake.scriptCborHex));
    witnessSet.set_native_scripts(scripts);
    return witnessSet;
  };
  const estimateFee = (body: C.TransactionBody) => {
    const witnesses = scriptWitnessSet(refsOf());
    const fakeSignatures = C.Vkeywitnesses.new();
    const fakeSignature = C.Ed25519Signature.from_bytes(new Uint8Array(64));
    for (const ref of refsOf()) {
      for (const signer of descriptor.cosigners) {
        fakeSignatures.add(C.Vkeywitness.new(C.Vkey.new(accountPublicKey(signer.accountXpub).derive(0).derive(ref.index).to_raw_key()), fakeSignature));
      }
    }
    for (const signer of descriptor.cosigners) {
      fakeSignatures.add(C.Vkeywitness.new(C.Vkey.new(accountPublicKey(signer.accountXpub).derive(2).derive(stakeRef.index).to_raw_key()), fakeSignature));
    }
    witnesses.set_vkeys(fakeSignatures);
    return BigInt(C.min_fee(C.Transaction.new(body, witnesses), linearFee).to_str());
  };

  let fee = 200_000n;
  let body: C.TransactionBody | undefined;
  let output = 0n;
  let lastHex = "";
  for (let iteration = 0; iteration < 8; iteration++) {
    selected.length = 0;
    totalIn = 0n;
    for (const utxo of [...candidates].sort((a, b) => (a.lovelace > b.lovelace ? -1 : 1))) {
      selected.push(utxo);
      totalIn += utxo.lovelace;
      if (totalIn + withdrawal + refund >= fee + registrationDeposit + 1_100_000n) break;
    }
    const target = totalIn + withdrawal + refund - fee - registrationDeposit;
    if (target <= 0n) throw new Error("余额不足以支付质押操作的手续费" + (registrationDeposit ? "和押金" : ""));
    body = assemble(target, fee);
    const nextFee = estimateFee(body);
    const rebuilt = assemble(target, nextFee);
    const hex = rebuilt.to_hex();
    output = target;
    if (nextFee === fee && hex === lastHex) { body = rebuilt; fee = nextFee; break; }
    fee = nextFee;
    lastHex = hex;
    if (iteration === 7) throw new Error("手续费估算未收敛，请重试");
  }
  if (!body) throw new Error("交易构建失败");
  const minOutput = minAdaFor(body.outputs().get(0), dataCost);
  if (output < minOutput) throw new Error(`输出低于链上最小值（${minOutput.toString()} lovelace），请补充 ADA 后重试`);

  const refs = refsOf();
  const witnessSet = scriptWitnessSet(refs);
  const tx = C.Transaction.new(body, witnessSet);
  const hash = C.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash().to_hex();
  const certificates: StakingCertificate[] = [];
  if (action.type === "delegate") {
    if (action.register) certificates.push({ type: "register" });
    certificates.push({ type: "delegate", poolId: action.poolId.trim() });
  } else if (action.type === "deregister") {
    certificates.push({ type: "deregister" });
  }

  return {
    format: "cardano-hd-multisig-tx",
    version: 3,
    network: descriptor.network,
    txCborHex: tx.to_hex(),
    txBodyHashHex: hash,
    inputs: selected.map(({ txHash, txIndex, address, derivationIndex }) => ({ txHash, txIndex, address, derivationIndex })),
    outputs: [{ address: args.receiveAddress, lovelace: output.toString() }],
    certificates,
    ...(withdrawal > 0n ? { withdrawalLovelace: withdrawal.toString() } : {}),
    feeLovelace: fee.toString(),
    requiredSignatures: descriptor.threshold,
    signingPaths: [...refs.map(({ index }) => `m/1854'/1815'/0'/0/${index}`), STAKE_SIGNING_PATH],
  };
}

function validAssetQuantities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_PACKAGE_ASSET_UNITS) return false;
  return value.every((asset) =>
    asset && typeof asset === "object" &&
    /^[0-9a-f]{56}$/.test(String(asset.policyId)) &&
    /^[0-9a-f]{0,64}$/.test(String(asset.assetNameHex)) &&
    typeof asset.quantity === "string" && /^[1-9][0-9]*$/.test(asset.quantity) && asset.quantity.length <= 20);
}

function sameAssets(declared: AssetQuantity[] | undefined, actual: AssetQuantity[]): boolean {
  const left = [...(declared ?? [])].sort((x, y) => (x.policyId + x.assetNameHex < y.policyId + y.assetNameHex ? -1 : 1));
  if (left.length !== actual.length) return false;
  return left.every((asset, index) =>
    asset.policyId === actual[index].policyId && asset.assetNameHex === actual[index].assetNameHex && asset.quantity === actual[index].quantity);
}

export function mergeSignedTransactions(unsignedHex: string, signedHexes: string[]): string {
  const unsigned = parseCanonicalTransaction(unsignedHex, "Unsigned transaction");
  const expectedBody = unsigned.body().to_hex();
  const bodyHash = C.FixedTransaction.new_from_body_bytes(unsigned.body().to_bytes()).transaction_hash().to_bytes();
  const merged = C.Vkeywitnesses.new();
  const seen = new Set<string>();
  const scripts = unsigned.witness_set().native_scripts();
  if (!scripts?.len()) throw new Error("Unsigned transaction 没有 native script witnesses");
  const requiredHashes = new Set<string>();
  for (let i = 0; i < scripts.len(); i++) {
    const required = scripts.get(i).get_required_signers();
    for (let j = 0; j < required.len(); j++) requiredHashes.add(required.get(j).to_hex());
  }

  for (const signedHex of signedHexes.filter((x) => x.trim())) {
    const signed = parseCanonicalTransaction(signedHex, "签名交易");
    if (signed.body().to_hex() !== expectedBody) throw new Error("签名交易的 transaction body 与 unsigned transaction 不一致");
    const vkeys = signed.witness_set().vkeys();
    if (!vkeys) continue;
    for (let i = 0; i < vkeys.len(); i++) {
      const witness = vkeys.get(i);
      const publicKey = witness.vkey().public_key();
      const keyHash = publicKey.hash().to_hex();
      if (!requiredHashes.has(keyHash)) throw new Error("签名交易包含不属于当前多签脚本的 witness");
      if (!publicKey.verify(bodyHash, witness.signature())) throw new Error("签名交易包含无效 witness");
      if (!seen.has(keyHash)) {
        merged.add(witness);
        seen.add(keyHash);
      }
    }
  }
  if (!merged.len()) throw new Error("没有找到 vkey witness");

  const witnesses = unsigned.witness_set();
  for (let i = 0; i < scripts.len(); i++) {
    const script = scripts.get(i).as_script_n_of_k();
    if (!script) throw new Error("仅支持 atLeast M-of-N native scripts");
    const required = script.native_scripts();
    let present = 0;
    for (let j = 0; j < required.len(); j++) {
      const hash = required.get(j).as_script_pubkey()?.addr_keyhash().to_hex();
      if (hash && seen.has(hash)) present++;
    }
    if (present < script.n()) throw new Error(`签名不足：地址脚本需要 ${script.n()} 个，当前只有 ${present} 个`);
  }
  witnesses.set_vkeys(merged);
  return C.Transaction.new(unsigned.body(), witnesses, unsigned.auxiliary_data()).to_hex();
}

export function validateSignedTransaction(unsignedHex: string, signedHex: string) {
  const unsigned = parseCanonicalTransaction(unsignedHex, "Unsigned transaction");
  const signed = parseCanonicalTransaction(signedHex, "签名交易");
  if (signed.body().to_hex() !== unsigned.body().to_hex())
    throw new Error("签名交易的 transaction body 与 unsigned transaction 不一致");
  const scripts = unsigned.witness_set().native_scripts();
  if (!scripts?.len()) throw new Error("Unsigned transaction 没有 native script witnesses");
  const requiredHashes = new Set<string>();
  for (let i = 0; i < scripts.len(); i++) {
    const required = scripts.get(i).get_required_signers();
    for (let j = 0; j < required.len(); j++) requiredHashes.add(required.get(j).to_hex());
  }
  const witnesses = signed.witness_set().vkeys();
  if (!witnesses?.len()) throw new Error("没有找到 vkey witness");
  const bodyHash = C.FixedTransaction.new_from_body_bytes(unsigned.body().to_bytes()).transaction_hash().to_bytes();
  const signerHashes: string[] = [];
  for (let i = 0; i < witnesses.len(); i++) {
    const witness = witnesses.get(i);
    const publicKey = witness.vkey().public_key();
    const keyHash = publicKey.hash().to_hex();
    if (!requiredHashes.has(keyHash)) throw new Error("签名交易包含不属于当前多签脚本的 witness");
    if (!publicKey.verify(bodyHash, witness.signature())) throw new Error("签名交易包含无效 witness");
    signerHashes.push(keyHash);
  }
  return { witnessCount: witnesses.len(), signerHashes };
}

export function addCip30WitnessSet(pkgValue: unknown, witnessSetHex: string) {
  const pkg = validateUnsignedPackage(pkgValue);
  const returned = C.TransactionWitnessSet.from_hex(cleanHex(witnessSetHex));
  if (returned.to_hex() !== cleanHex(witnessSetHex).toLowerCase())
    throw new Error("外部钱包 witness CBOR 非规范编码或包含额外数据");
  if (returned.native_scripts()?.len() || returned.bootstraps()?.len() || returned.plutus_data()?.len() ||
      returned.plutus_scripts()?.len() || returned.redeemers()?.len())
    throw new Error("外部钱包返回了非预期的非 VKey witness 数据");
  const vkeys = returned.vkeys();
  if (!vkeys?.len()) throw new Error("外部钱包没有返回可用的 VKey witness");

  const unsigned = C.Transaction.from_hex(pkg.txCborHex);
  const witnesses = C.TransactionWitnessSet.new();
  witnesses.set_vkeys(vkeys);
  const signed = C.Transaction.new(unsigned.body(), witnesses, unsigned.auxiliary_data()).to_hex();
  validateSignedTransaction(pkg.txCborHex, signed);
  return signed;
}

export function inspectFinalTransaction(txHex: string) {
  const tx = parseCanonicalTransaction(txHex, "最终交易");
  const body = tx.body();
  const outputs = body.outputs();
  const certs = body.certs();
  let certificates: StakingCertificate[] = [];
  if (certs) {
    for (let i = 0; i < certs.len(); i++) {
      const cert = certs.get(i);
      if (cert.kind() === C.CertificateKind.StakeRegistration) certificates.push({ type: "register" });
      else if (cert.kind() === C.CertificateKind.StakeDeregistration) certificates.push({ type: "deregister" });
      else if (cert.kind() === C.CertificateKind.StakeDelegation) certificates.push({ type: "delegate", poolId: poolHashToBech32(cert.as_stake_delegation()!.pool_keyhash().to_hex()) });
    }
  }
  const withdrawals = body.withdrawals();
  let withdrawalLovelace: string | null = null;
  if (withdrawals && withdrawals.len()) withdrawalLovelace = withdrawals.get(withdrawals.keys().get(0))!.to_str();
  return {
    txId: C.FixedTransaction.new_from_body_bytes(body.to_bytes()).transaction_hash().to_hex(),
    inputCount: body.inputs().len(),
    outputs: Array.from({ length: outputs.len() }, (_, index) => ({
      address: outputs.get(index).address().to_bech32(),
      lovelace: outputs.get(index).amount().coin().to_str(),
      assets: readAssetQuantities(outputs.get(index).amount()),
    })),
    certificates,
    withdrawalLovelace,
    feeLovelace: body.fee().to_str(),
    ttl: body.ttl_bignum()?.to_str() ?? null,
    witnessCount: tx.witness_set().vkeys()?.len() ?? 0,
  };
}

export type CardanoTransactionTextEnvelope = {
  type: "Tx ConwayEra";
  description: string;
  cborHex: string;
};

/**
 * Standard cardano-cli text envelope accepted by Eternl's transaction importer.
 * Only the outer representation changes; the exact transaction CBOR and TXID stay unchanged.
 */
export function transactionTextEnvelope(pkgValue: unknown): CardanoTransactionTextEnvelope {
  const pkg = validateUnsignedPackage(pkgValue);
  return {
    type: "Tx ConwayEra",
    description: `Unsigned Cardano Sparrow multisig transaction; TXID ${pkg.txBodyHashHex}`,
    cborHex: pkg.txCborHex,
  };
}

/** Extract a full transaction CBOR from raw hex or a Cardano/Eternl text envelope. */
export function transactionCborFromImport(value: unknown): string {
  const candidate = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { cborHex?: unknown }).cborHex === "string"
      ? (value as { cborHex: string }).cborHex
      : value && typeof value === "object" && typeof (value as { signedTxHex?: unknown }).signedTxHex === "string"
        ? (value as { signedTxHex: string }).signedTxHex
        : "";
  if (!candidate) throw new Error("文件不包含可识别的交易 CBOR");
  const hex = cleanHex(candidate).toLowerCase();
  parseCanonicalTransaction(hex, "导入交易");
  return hex;
}

/**
 * Rebuild the Sparrow safety summary around an Eternl/raw transaction using only
 * the active descriptor and freshly synchronized UTXOs. No address/path metadata
 * from the external envelope is trusted.
 */
export function unsignedPackageFromTransaction(
  txCborHex: string,
  descriptorValue: unknown,
  addresses: DerivedAddress[],
  utxos: Utxo[],
): UnsignedPackage {
  const descriptor = validateDescriptor(descriptorValue);
  const hex = transactionCborFromImport(txCborHex);
  const tx = parseCanonicalTransaction(hex, "导入交易");
  const body = tx.body();
  const live = new Map(utxos.map((utxo) => [`${utxo.txHash}#${utxo.txIndex}`, utxo]));
  const inputs: UnsignedPackage["inputs"] = [];
  for (let index = 0; index < body.inputs().len(); index += 1) {
    const input = body.inputs().get(index);
    const txHash = input.transaction_id().to_hex();
    const txIndex = input.index();
    const current = live.get(`${txHash}#${txIndex}`);
    if (!current) throw new Error("Eternl/CBOR 交易包含当前钱包未同步到的输入，请先同步钱包再导入");
    const derived = addresses.find((address) => address.index === current.derivationIndex);
    if (!derived || derived.address !== current.address)
      throw new Error("Eternl/CBOR 交易输入不属于当前钱包的派生地址");
    inputs.push({ txHash, txIndex, address: current.address, derivationIndex: current.derivationIndex });
  }
  const inspected = inspectFinalTransaction(hex);
  const outputs: UnsignedPackage["outputs"] = inspected.outputs.map((output) => ({
    address: output.address,
    lovelace: output.lovelace,
    ...(output.assets.length ? { assets: output.assets } : {}),
  }));
  const hasStaking = inspected.certificates.length > 0 || inspected.withdrawalLovelace !== null;
  const hasAssets = outputs.some((output) => output.assets?.length);
  const derivationIndexes = [...new Set(inputs.map((input) => input.derivationIndex))].sort((a, b) => a - b);
  const pkg: UnsignedPackage = {
    format: "cardano-hd-multisig-tx",
    version: hasStaking ? 3 : hasAssets ? 2 : 1,
    network: descriptor.network,
    txCborHex: hex,
    txBodyHashHex: inspected.txId,
    inputs,
    outputs,
    ...(hasStaking ? { certificates: inspected.certificates } : {}),
    ...(inspected.withdrawalLovelace ? { withdrawalLovelace: inspected.withdrawalLovelace } : {}),
    feeLovelace: inspected.feeLovelace,
    requiredSignatures: descriptor.threshold,
    signingPaths: [
      ...derivationIndexes.map((index) => `m/1854'/1815'/0'/0/${index}`),
      ...(hasStaking ? [STAKE_SIGNING_PATH] : []),
    ],
  };
  return validateUnsignedPackage(pkg);
}

export function poolHashToBech32(poolKeyHashHex: string): string {
  return bech32.encode("pool", bech32.toWords(hexToBytes(poolKeyHashHex)), 200);
}

type ParsedStakingCertificates = { certificates: StakingCertificate[]; stakeScriptHashHex: string };

// Structural rules for certificates inside a v3 package: only the three
// Shelley-era multisig-safe certificate kinds, all bound to one identical
// script stake credential, in the exact combinations the wallet builder emits.
function parseStakingCertificates(certs: C.Certificates): ParsedStakingCertificates {
  const allowed = new Set([C.CertificateKind.StakeRegistration, C.CertificateKind.StakeDeregistration, C.CertificateKind.StakeDelegation]);
  const parsed: StakingCertificate[] = [];
  const poolKeyHashes: string[] = [];
  let stakeScriptHash: string | null = null;
  for (let i = 0; i < certs.len(); i++) {
    const cert = certs.get(i);
    const kind = cert.kind();
    if (!allowed.has(kind)) throw new Error("签名包包含不支持的质押证书类型");
    const credential = kind === C.CertificateKind.StakeDelegation
      ? cert.as_stake_delegation()!.stake_credential()
      : kind === C.CertificateKind.StakeRegistration
        ? cert.as_stake_registration()!.stake_credential()
        : cert.as_stake_deregistration()!.stake_credential();
    if (!credential.has_script_hash()) throw new Error("质押证书必须使用脚本质押凭证");
    const hashHex = credential.to_scripthash()!.to_hex();
    if (stakeScriptHash === null) stakeScriptHash = hashHex;
    else if (stakeScriptHash !== hashHex) throw new Error("签名包的所有质押证书必须使用同一个质押脚本");
    if (kind === C.CertificateKind.StakeDelegation) {
      parsed.push({ type: "delegate", poolId: poolHashToBech32(cert.as_stake_delegation()!.pool_keyhash().to_hex()) });
    } else if (kind === C.CertificateKind.StakeRegistration) {
      parsed.push({ type: "register" });
    } else {
      parsed.push({ type: "deregister" });
    }
  }
  const shape = parsed.map((certificate) => certificate.type).join(",");
  if (!["", "register,delegate", "delegate", "deregister"].includes(shape))
    throw new Error("签名包的质押证书组合不受支持");
  return { certificates: parsed, stakeScriptHashHex: stakeScriptHash ?? "" };
}

function validCertificateSummary(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 2) return false;
  return value.every((certificate) =>
    certificate && typeof certificate === "object" &&
    ((certificate.type === "register") ||
      (certificate.type === "deregister") ||
      (certificate.type === "delegate" && /^[a-z0-9]+$/i.test(String(certificate.poolId)) && String(certificate.poolId).startsWith("pool1"))));
}

function sameCertificates(declared: StakingCertificate[] | undefined, actual: StakingCertificate[]): boolean {
  const left = declared ?? [];
  if (left.length !== actual.length) return false;
  return left.every((certificate, index) => {
    if (certificate.type !== actual[index].type) return false;
    const counterparty = actual[index];
    if (certificate.type === "delegate" && counterparty.type === "delegate" && certificate.poolId !== counterparty.poolId) return false;
    return true;
  });
}

export function validateUnsignedPackage(value: unknown): UnsignedPackage {
  const pkg = value as Partial<UnsignedPackage>;
  if (pkg?.format !== "cardano-hd-multisig-tx" || !pkg.version || ![1, 2, 3].includes(pkg.version) || !pkg.network || !["mainnet", "preprod"].includes(pkg.network))
    throw new Error("不是受支持的签名包");
  if (!pkg.txCborHex || !pkg.txBodyHashHex || !Array.isArray(pkg.signingPaths) || !pkg.signingPaths.length)
    throw new Error("签名包缺少交易 CBOR、哈希或签名路径");
  if (!Array.isArray(pkg.inputs) || !Array.isArray(pkg.outputs) || pkg.outputs.length < 1 || pkg.outputs.length > 2 || !pkg.feeLovelace)
    throw new Error("签名包缺少输入、输出或手续费摘要");
  const stakingPathCount = pkg.signingPaths.filter((path) => path === STAKE_SIGNING_PATH).length;
  if (!Number.isInteger(pkg.requiredSignatures) || pkg.requiredSignatures! < 1 || pkg.requiredSignatures! > 10 ||
    pkg.signingPaths.some((path) => !/^m\/1854'\/1815'\/0'\/(0\/\d+|2\/0)$/.test(path)) ||
    stakingPathCount > 1 ||
    (stakingPathCount === 1 && pkg.version !== 3))
    throw new Error("签名包不是受支持的 CIP-1854 M-of-N 交易");
  if (pkg.inputs.some((input) => "derivationRole" in input && (input as { derivationRole?: unknown }).derivationRole !== 0))
    throw new Error("签名包不是受支持的 CIP-1854 M-of-N 交易");
  if (pkg.outputs.some((output) => !validAssetQuantities(output.assets)) || (pkg.version !== 2 && pkg.version !== 3 && pkg.outputs.some((output) => output.assets?.length)))
    throw new Error("签名包不是受支持的 CIP-1854 M-of-N 交易");
  if (pkg.outputs.reduce((total, output) => total + (output.assets?.length ?? 0), 0) > MAX_PACKAGE_ASSET_UNITS)
    throw new Error("签名包资产数量超出安全范围");
  if (!validCertificateSummary(pkg.certificates)) throw new Error("签名包不是受支持的 CIP-1854 M-of-N 交易");
  if (pkg.withdrawalLovelace !== undefined && !/^[1-9][0-9]*$/.test(pkg.withdrawalLovelace)) throw new Error("签名包提款金额无效");
  if ((pkg.certificates?.length || pkg.withdrawalLovelace) && pkg.version !== 3) throw new Error("签名包包含当前多签流程不支持的交易字段");
  if (pkg.version === 3 && !pkg.certificates?.length && !pkg.withdrawalLovelace) throw new Error("质押签名包缺少证书或提款");
  if (transactionId(pkg.txCborHex) !== pkg.txBodyHashHex) throw new Error("签名包的 transaction ID 与 CBOR 不一致");
  const tx = parseCanonicalTransaction(pkg.txCborHex, "签名包交易");
  const body = tx.body();
  const witnessSet = tx.witness_set();
  if (!body.ttl_bignum() || BigInt(body.ttl_bignum()!.to_str()) <= 0n)
    throw new Error("签名包缺少交易有效期");
  if (witnessSet.vkeys()?.len() || witnessSet.bootstraps()?.len() || witnessSet.plutus_data()?.len() ||
      witnessSet.plutus_scripts()?.len() || witnessSet.redeemers()?.len())
    throw new Error("Unsigned 签名包包含不应存在的额外 witness 数据");
  const bodyCerts = body.certs();
  const bodyWithdrawals = body.withdrawals();
  const staking = bodyCerts ? parseStakingCertificates(bodyCerts) : null;
  let parsedWithdrawalLovelace = "0";
  if (bodyWithdrawals) {
    if (bodyWithdrawals.len() !== 1) throw new Error("签名包提款数量必须恰好为一项");
    const rewardAddress = bodyWithdrawals.keys().get(0);
    if (rewardAddress.to_address().network_id() !== networkConfig(pkg.network).networkId)
      throw new Error("签名包提款地址与声明网络不一致");
    if (!rewardAddress.payment_cred().has_script_hash()) throw new Error("提款必须使用脚本质押凭证");
    if (staking && rewardAddress.payment_cred().to_scripthash()!.to_hex() !== staking.stakeScriptHashHex)
      throw new Error("签名包的提款与质押证书使用了不同的质押脚本");
    parsedWithdrawalLovelace = bodyWithdrawals.get(rewardAddress)!.to_str();
  }
  const hasStakingFields = !!(bodyCerts || bodyWithdrawals);
  if (hasStakingFields && pkg.version !== 3) throw new Error("签名包包含当前多签流程不支持的交易字段");
  if (!hasStakingFields && pkg.version === 3) throw new Error("质押签名包缺少证书或提款");
  if (staking && !sameCertificates(pkg.certificates, staking.certificates))
    throw new Error("签名包摘要与交易 CBOR 不一致");
  if ((pkg.withdrawalLovelace ?? "0") !== parsedWithdrawalLovelace) throw new Error("签名包摘要与交易 CBOR 不一致");
  if (!tx.is_valid() || tx.auxiliary_data() || body.auxiliary_data_hash() || body.mint() ||
      body.validity_start_interval_bignum() || body.script_data_hash() || body.collateral() || body.required_signers() ||
      body.collateral_return() || body.total_collateral() || body.reference_inputs() || body.voting_procedures() ||
      body.voting_proposals() || body.current_treasury_value() || body.donation() || body.update())
    throw new Error("签名包包含当前多签流程不支持的交易字段");
  const expectedNetwork = networkConfig(pkg.network).networkId;
  if (body.network_id()?.kind() !== (pkg.network === "mainnet" ? C.NetworkIdKind.Mainnet : C.NetworkIdKind.Testnet))
    throw new Error("签名包网络字段与声明网络不一致");
  if (body.outputs().len() !== pkg.outputs.length) throw new Error("签名包摘要与交易 CBOR 不一致");
  for (let i = 0; i < body.outputs().len(); i++) {
    const output = body.outputs().get(i);
    if (output.address().network_id() !== expectedNetwork) throw new Error("签名包包含其他网络的输出地址");
    if (output.data_hash() || output.plutus_data() || output.script_ref())
      throw new Error("签名包包含 Datum 或 reference script 输出");
    if (pkg.version === 1 && output.amount().multiasset())
      throw new Error("签名包包含资产、Datum 或 reference script 输出");
    if ((pkg.version === 2 || pkg.version === 3) && hasStakingFields && output.amount().multiasset())
      throw new Error("质押交易不支持资产输出");
    if (!sameAssets(pkg.outputs[i].assets, readAssetQuantities(output.amount())))
      throw new Error("签名包摘要与交易 CBOR 不一致");
  }
  const parsed = inspectFinalTransaction(pkg.txCborHex);
  const fee = BigInt(pkg.feeLovelace);
  if (fee <= 0n || fee > 5_000_000n || pkg.outputs.some((output) => BigInt(output.lovelace) <= 0n))
    throw new Error("签名包金额或手续费超出安全范围");
  if (parsed.outputs.length !== pkg.outputs.length || parsed.feeLovelace !== pkg.feeLovelace ||
      parsed.outputs.some((output, index) => output.address !== pkg.outputs![index].address || output.lovelace !== pkg.outputs![index].lovelace))
    throw new Error("签名包摘要与交易 CBOR 不一致");
  const bodyInputs = body.inputs();
  if (bodyInputs.len() !== pkg.inputs.length || pkg.inputs.some((input, index) => {
    const bodyInput = bodyInputs.get(index);
    return bodyInput.transaction_id().to_hex() !== input.txHash || bodyInput.index() !== input.txIndex;
  })) throw new Error("签名包输入摘要与交易 CBOR 不一致");
  return pkg as UnsignedPackage;
}

export type StakingContext = { rewardsLovelace: bigint; keyDeposit: bigint; registered: boolean };

export function validatePackageForWallet(
  pkgValue: unknown,
  descriptor: Descriptor,
  addresses: DerivedAddress[],
  utxos: Utxo[],
  stakingContext?: StakingContext,
  currentTipSlot?: bigint,
) {
  const pkg = validateUnsignedPackage(pkgValue);
  if (currentTipSlot !== undefined) {
    if (currentTipSlot < 0n) throw new Error("当前链上 slot 无效");
    const ttl = BigInt(C.Transaction.from_hex(pkg.txCborHex).body().ttl_bignum()!.to_str());
    if (ttl <= currentTipSlot || ttl > currentTipSlot + TX_TTL_SLOTS)
      throw new Error("签名包有效期已过或超出一小时安全窗口，请重新构建交易");
  }
  if (pkg.network !== descriptor.network) throw new Error("签名包网络与当前钱包不一致");
  if (pkg.requiredSignatures !== descriptor.threshold) throw new Error("签名包阈值与当前钱包策略不一致");
  const live = new Map(utxos.map((utxo) => [`${utxo.txHash}#${utxo.txIndex}`, utxo]));
  const destination = C.Address.from_bech32(pkg.outputs[0].address);
  if (destination.payment_cred()?.has_script_hash() && !addresses.some((item) => item.address === pkg.outputs[0].address))
    throw new Error("当前不支持向未知脚本地址付款（需要 Datum 支持）");
  if (pkg.outputs.length === 2 && !addresses.some((item) => item.address === pkg.outputs[1].address))
    throw new Error("签名包找零地址不属于当前多签钱包");
  if (pkg.version === 3 && !addresses.some((item) => item.address === pkg.outputs[0].address))
    throw new Error("质押交易返还地址不属于当前多签钱包");
  for (const input of pkg.inputs) {
    const ref = { index: input.derivationIndex } as DerivationRef;
    const derived = addressFor(addresses, ref);
    if (!derived || derived.address !== input.address) throw new Error("签名包输入地址不属于当前钱包");
    const current = live.get(`${input.txHash}#${input.txIndex}`);
    if (!current || current.address !== input.address || current.derivationIndex !== input.derivationIndex)
      throw new Error("签名包输入不是当前钱包已同步的未花费输出");
  }
  const refs = [...new Map(pkg.inputs.map((input) => {
    const ref = { index: input.derivationIndex } as DerivationRef;
    return [String(ref.index), ref] as const;
  })).values()].sort((a, b) => a.index - b.index);
  const inputPaths = refs.map(({ index }) => `m/1854'/1815'/0'/0/${index}`);
  const expectsStakePath = pkg.version === 3;
  const paths = expectsStakePath ? [...inputPaths, STAKE_SIGNING_PATH] : inputPaths;
  if (paths.length !== pkg.signingPaths.length || paths.some((path, index) => path !== pkg.signingPaths[index]))
    throw new Error("签名包路径与输入地址不一致");
  const expectedScripts = refs.map((ref) => addressFor(addresses, ref)!.scriptCborHex).sort();
  if (expectsStakePath) expectedScripts.push(deriveStakeScript(descriptor).scriptCborHex);
  const scripts = C.Transaction.from_hex(pkg.txCborHex).witness_set().native_scripts();
  const actualScripts = scripts ? Array.from({ length: scripts.len() }, (_, index) => scripts.get(index).to_hex()).sort() : [];
  const sortedExpected = expectedScripts.sort();
  if (sortedExpected.length !== actualScripts.length || sortedExpected.some((script, index) => script !== actualScripts[index]))
    throw new Error("签名包原生脚本与当前钱包不一致");
  const withdrawal = BigInt(pkg.withdrawalLovelace ?? "0");
  if (pkg.version === 3) {
    if (!stakingContext) throw new Error("缺少质押状态，无法校验质押签名包");
    const body = C.Transaction.from_hex(pkg.txCborHex).body();
    const expectedStakeHash = deriveStakeScript(descriptor).credential.to_scripthash()!.to_hex();
    const certificates = body.certs();
    if (certificates && parseStakingCertificates(certificates).stakeScriptHashHex !== expectedStakeHash)
      throw new Error("质押证书不属于当前钱包的质押脚本");
    const withdrawalAccount = body.withdrawals();
    if (withdrawalAccount?.len()) {
      const actualStakeHash = withdrawalAccount.keys().get(0).payment_cred().to_scripthash()?.to_hex();
      if (actualStakeHash !== expectedStakeHash)
        throw new Error("提款账户不属于当前钱包的质押脚本");
      if (!stakingContext.registered) throw new Error("质押凭证尚未注册，无法提取奖励");
    }
    const registering = pkg.certificates?.some((certificate) => certificate.type === "register") ?? false;
    const deregistering = pkg.certificates?.some((certificate) => certificate.type === "deregister") ?? false;
    if (registering && stakingContext.registered) throw new Error("质押凭证已注册，签名包不能再次注册");
    if (!registering && !stakingContext.registered && (pkg.certificates?.length ?? 0) > 0)
      throw new Error("质押凭证尚未注册，请先注册并委托");
    if (deregistering && !stakingContext.registered) throw new Error("质押凭证尚未注册，无法解除质押");
    if (deregistering && withdrawal !== stakingContext.rewardsLovelace)
      throw new Error("解除质押的提款金额与当前奖励不一致");
    if (!deregistering && withdrawal > 0n && withdrawal !== stakingContext.rewardsLovelace)
      throw new Error("提款金额与当前可得奖励不一致");
  }
  const inputTotal = pkg.inputs.reduce((sum, input) => sum + live.get(`${input.txHash}#${input.txIndex}`)!.lovelace, 0n);
  const outputTotal = pkg.outputs.reduce((sum, output) => sum + BigInt(output.lovelace), 0n);
  const registerCost = pkg.version === 3 && pkg.certificates?.some((certificate) => certificate.type === "register")
    ? stakingContext!.keyDeposit : 0n;
  const refund = pkg.version === 3 && pkg.certificates?.some((certificate) => certificate.type === "deregister")
    ? stakingContext!.keyDeposit : 0n;
  if (inputTotal + withdrawal + refund !== outputTotal + BigInt(pkg.feeLovelace) + registerCost)
    throw new Error("签名包输入、输出与手续费不平衡");
  const inputAssets = toAssetMap(pkg.inputs.flatMap((input) => assetsOf(live.get(`${input.txHash}#${input.txIndex}`)!)));
  const outputAssets = new Map<string, bigint>();
  for (const output of pkg.outputs) {
    for (const asset of output.assets ?? []) {
      if (!inputAssets.has(unitKey(asset.policyId, asset.assetNameHex))) throw new Error("签名包包含输入中不存在的资产");
      const key = unitKey(asset.policyId, asset.assetNameHex);
      outputAssets.set(key, (outputAssets.get(key) ?? 0n) + BigInt(asset.quantity));
    }
  }
  for (const [key, unit] of inputAssets) {
    if ((outputAssets.get(key) ?? 0n) !== unit.quantity) throw new Error("签名包输入、输出与手续费不平衡");
  }
  for (const [key, quantity] of outputAssets) {
    const unit = inputAssets.get(key);
    if (!unit || quantity > unit.quantity) throw new Error("签名包包含输入中不存在的资产");
  }
  return pkg;
}

export function addLedgerWitnesses(
  pkgValue: unknown,
  accountXpub: string,
  deviceWitnesses: Array<{ path: number[]; witnessSignatureHex: string }>,
) {
  const pkg = validateUnsignedPackage(pkgValue);
  const requestedPaths = new Set(pkg.signingPaths.map(parseCip1854Path).map((path) => JSON.stringify(path)));
  const returnedPaths = new Set(deviceWitnesses.map((witness) => JSON.stringify(witness.path)));
  if (requestedPaths.size !== returnedPaths.size || [...requestedPaths].some((path) => !returnedPaths.has(path)))
    throw new Error("Ledger 返回的签名路径与请求不一致");

  const tx = C.Transaction.from_hex(pkg.txCborHex);
  const scripts = tx.witness_set().native_scripts();
  if (!scripts?.len()) throw new Error("交易中没有 native script witnesses");
  const requiredHashes = new Set<string>();
  for (let i = 0; i < scripts.len(); i++) {
    const required = scripts.get(i).get_required_signers();
    for (let j = 0; j < required.len(); j++) requiredHashes.add(required.get(j).to_hex());
  }

  const account = accountPublicKey(accountXpub);
  const vkeys = tx.witness_set().vkeys() ?? C.Vkeywitnesses.new();
  const bodyHash = C.TransactionHash.from_hex(pkg.txBodyHashHex).to_bytes();
  for (const witness of deviceWitnesses) {
    const path = witness.path;
    const roleOk = path[3] === 0 || (path[3] === 2 && path[4] === 0);
    if (path.length !== 5 || path[0] !== HARDENED + 1854 || path[1] !== HARDENED + 1815 || path[2] !== HARDENED || !roleOk)
      throw new Error("Ledger 返回了非预期的 CIP-1854 签名路径");
    const publicKey = account.derive(path[3]).derive(path[4]).to_raw_key();
    const keyHash = publicKey.hash().to_hex();
    if (!requiredHashes.has(keyHash)) throw new Error(`这个 Ledger 的 m/1854'/1815'/0'/${path[3]}/${path[4]} 公钥不属于该多签账户`);
    const signature = C.Ed25519Signature.from_hex(witness.witnessSignatureHex);
    if (!publicKey.verify(bodyHash, signature)) throw new Error("Ledger 返回的交易签名验证失败");
    vkeys.add(C.Vkeywitness.new(C.Vkey.new(publicKey), signature));
  }
  const witnessSet = tx.witness_set();
  witnessSet.set_vkeys(vkeys);
  return C.Transaction.new(tx.body(), witnessSet, tx.auxiliary_data()).to_hex();
}

export function transactionId(txHex: string): string {
  const tx = parseCanonicalTransaction(txHex, "交易");
  return C.FixedTransaction.new_from_body_bytes(tx.body().to_bytes()).transaction_hash().to_hex();
}

function parseCanonicalTransaction(value: string, label: string): C.Transaction {
  const hex = cleanHex(value).toLowerCase();
  const tx = C.Transaction.from_hex(hex);
  if (tx.to_hex() !== hex) throw new Error(`${label} CBOR 非规范编码或包含额外数据`);
  return tx;
}

function cleanHex(value: string) {
  const hex = value.trim().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error("交易 CBOR 必须是偶数长度的十六进制字符串");
  return hex;
}

function parseCip1854Path(value: string) {
  const match = value.match(/^m\/1854'\/1815'\/0'\/(0|2)\/(\d+)$/);
  if (!match || (match[1] === "2" && match[2] !== "0")) throw new Error("签名包不是受支持的 CIP-1854 M-of-N 交易");
  return [HARDENED + 1854, HARDENED + 1815, HARDENED, Number(match[1]), Number(match[2])];
}

function accountPublicKey(encoded: string) {
  const decoded = bech32.decode(encoded, 200);
  if (decoded.prefix !== "acct_shared_xvk") throw new Error("公钥前缀必须是 acct_shared_xvk");
  const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
  if (bytes.length !== 64) throw new Error("acct_shared_xvk 必须包含 64 字节公钥与 chain code");
  return C.Bip32PublicKey.from_bytes(bytes);
}

export interface LedgerSigner {
  readonly name: string;
  isSupported(): boolean;
  getAccountXpub(account: number): Promise<string>;
  signTransaction(request: UnsignedPackage): Promise<string>;
}
