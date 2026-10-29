import type { AssetUnit, DerivedAddress, TransactionSide, Utxo, WalletTransaction } from "./types";
import { networkConfig, type CardanoNetwork } from "./network";
import { resolveAssetMeta, type AssetInfoRow } from "./assets";
import { inspectFinalTransaction, rewardAddressOf, transactionId } from "./cardano";
import { activeSource, sourceSettings, SourceHttpError, withSource, type DataSource } from "./data-source";
import { bfRequest, bfResponse } from "./blockfrost";

async function requestResponse(network: CardanoNetwork, path: string, init?: RequestInit, source: DataSource = "koios"): Promise<Response> {
  if (source === "blockfrost") return bfResponse(network, path, init);
  let response: Response;
  try { response = await fetch(`${networkConfig(network).apiPrefix}${path}`, init); }
  catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SourceHttpError("koios", 0);
  }
  if (!response.ok) throw new SourceHttpError("koios", response.status);
  return response;
}

async function request<T>(network: CardanoNetwork, path: string, init?: RequestInit, source: DataSource = "koios"): Promise<T> {
  const response = await requestResponse(network, path, init, source);
  return response.json() as Promise<T>;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const ADDRESS_BATCH = 20;
const addressBatches = (addresses: string[]) => Array.from(
  { length: Math.ceil(addresses.length / ADDRESS_BATCH) }, (_, i) =>
    addresses.slice(i * ADDRESS_BATCH, (i + 1) * ADDRESS_BATCH));

async function requestAll<T>(network: CardanoNetwork, path: string, body: object, signal?: AbortSignal, source: DataSource = "koios"): Promise<T[]> {
  const order = path === "/address_txs" ? "block_height.asc,tx_hash.asc" : "tx_hash.asc,tx_index.asc";
  const rows: T[] = [];
  let expectedTotal: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE;
    const response = await requestResponse(network, `${path}?order=${order}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Range: `${start}-${start + PAGE_SIZE - 1}`, Prefer: "count=exact" },
      body: JSON.stringify(body),
      signal,
    }, source);
    const batch: unknown = await response.json();
    if (!Array.isArray(batch)) throw new Error("Koios 返回的分页数据格式无效，已停止同步");
    const contentRange = response.headers.get("content-range");
    const bounds = contentRange?.match(/^(\d+)-(\d+)\/(\d+|\*)$/);
    if (batch.length) {
      if (!bounds || Number(bounds[1]) !== start || Number(bounds[2]) !== start + batch.length - 1 || batch.length > PAGE_SIZE)
        throw new Error("Koios 分页结果不完整，已停止同步");
    } else if (!/^\*\/\d+$/.test(contentRange ?? "")) {
      throw new Error("Koios 分页结果不完整，已停止同步");
    }
    rows.push(...batch as T[]);
    const total = Number(bounds?.[3] ?? contentRange?.slice(2));
    if (!Number.isSafeInteger(total) || total < rows.length)
      throw new Error("Koios 分页总数无效，已停止同步");
    if (expectedTotal !== null && total !== expectedTotal)
      throw new Error("Koios 分页总数在同步时发生变化，请重试");
    expectedTotal = total;
    if (rows.length === total) return rows;
    if (batch.length !== PAGE_SIZE) throw new Error("Koios 分页提前结束，已停止同步");
  }
  throw new Error("Koios 数据超过安全扫描上限，已停止同步");
}

async function requestRecentTransactions(network: CardanoNetwork, addresses: string[], signal?: AbortSignal, source: DataSource = "koios") {
  const response = await requestResponse(network, "/address_txs?order=block_height.desc,tx_hash.desc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Range: "0-99", Prefer: "count=planned" },
    body: JSON.stringify({ _addresses: addresses }), signal,
  }, source);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.length > 100) throw new Error("Koios 交易历史数据无效");
  return rows as Array<{ tx_hash: string; block_height: number; block_time: number }>;
}

function apiFor(source: DataSource) {
  return {
    request: <T>(network: CardanoNetwork, path: string, init?: RequestInit) => request<T>(network, path, init, source),
    requestAll: <T>(network: CardanoNetwork, path: string, body: object, signal?: AbortSignal) => requestAll<T>(network, path, body, signal, source),
    requestRecentTransactions: (network: CardanoNetwork, addresses: string[], signal?: AbortSignal) => requestRecentTransactions(network, addresses, signal, source),
  };
}

export type AssetBalance = { policyId: string; assetNameHex: string; quantity: bigint };

type KoiosAssetRow = { policy_id?: unknown; asset_name?: unknown; quantity?: unknown };

// Koios reports asset names as hex strings (empty string for nameless assets).
function parseKoiosAssets(rows: unknown): AssetUnit[] {
  if (rows == null) return [];
  if (!Array.isArray(rows)) throw new Error("Koios 返回的资产列表格式无效");
  const assets: AssetUnit[] = [];
  const seen = new Set<string>();
  for (const row of rows as KoiosAssetRow[]) {
    const policyId = typeof row?.policy_id === "string" ? row.policy_id.toLowerCase() : "";
    const assetNameHex = typeof row?.asset_name === "string" ? row.asset_name.toLowerCase() : "";
    const quantity = typeof row?.quantity === "string" && /^[0-9]+$/.test(row.quantity) ? BigInt(row.quantity) : null;
    if (!/^[0-9a-f]{56}$/.test(policyId) || !/^[0-9a-f]{0,64}$/.test(assetNameHex) || quantity === null || quantity <= 0n)
      throw new Error("Koios 返回的资产数量或标识无效");
    const unit = `${policyId}.${assetNameHex}`;
    if (seen.has(unit)) throw new Error("Koios 返回了重复的资产条目，已停止同步");
    seen.add(unit);
    assets.push({ policyId, assetNameHex, quantity });
  }
  return assets;
}

async function fetchWalletFrom(addresses: DerivedAddress[], network: CardanoNetwork, signal?: AbortSignal, source: DataSource = "koios") {
  const { request, requestAll, requestRecentTransactions } = apiFor(source);
  const allAddresses = addresses.map((a) => a.address);
  type UtxoRow = {
    tx_hash: string;
    tx_index: number;
    address: string;
    value: string;
    asset_list?: unknown[] | null;
  };
  const rows: UtxoRow[] = [];
  const outputs: Array<{ address: string }> = [];
  const recent = new Map<string, { tx_hash: string; block_height: number; block_time: number }>();
  for (const batch of addressBatches(allAddresses)) {
    rows.push(...await requestAll<UtxoRow>(network, "/address_utxos", { _addresses: batch, _extended: true }, signal));
    const found = await request<Array<{ address: string }>>(network, "/address_info?select=address", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _addresses: batch }), signal,
    });
    if (!Array.isArray(found) || found.length > batch.length || found.some((row) => !batch.includes(row?.address)))
      throw new Error("Koios 已用地址结果无效");
    outputs.push(...found);
    for (const row of await requestRecentTransactions(network, batch, signal)) {
      if (typeof row.tx_hash !== "string") throw new Error("Koios 交易历史数据无效");
      recent.set(row.tx_hash, row);
    }
  }
  const transactionRows = [...recent.values()].sort((a, b) =>
    b.block_time - a.block_time || b.tx_hash.localeCompare(a.tx_hash)).slice(0, 100);
  if (transactionRows.some((row) => !/^[0-9a-f]{64}$/i.test(row.tx_hash) ||
      !Number.isSafeInteger(row.block_height) || row.block_height < 0 ||
      !Number.isSafeInteger(row.block_time) || row.block_time < 0))
    throw new Error("Koios 交易历史数据无效");

  const walletAddresses = new Set(allAddresses);
  const baseByAddress = new Map(addresses.map((a) => [a.address, { index: a.index }]));
  const utxos: Utxo[] = [];
  const seenUtxos = new Set<string>();
  const balances = new Map<string, AssetBalance>();
  for (const row of rows) {
    if (!row || !/^[0-9a-f]{64}$/i.test(row.tx_hash) || !Number.isSafeInteger(row.tx_index) || row.tx_index < 0 ||
        typeof row.value !== "string" || !/^[0-9]+$/.test(row.value) || BigInt(row.value) <= 0n)
      throw new Error("Koios 返回的 UTXO 内容无效");
    const utxoKey = `${row.tx_hash.toLowerCase()}#${row.tx_index}`;
    if (seenUtxos.has(utxoKey)) throw new Error("Koios 返回了重复的 UTXO");
    seenUtxos.add(utxoKey);
    const derivation = baseByAddress.get(row.address);
    if (!derivation) throw new Error("Koios 返回了不属于当前钱包的 UTXO，已停止同步");
    if (!Array.isArray(row.asset_list)) throw new Error("Koios 返回的 UTXO 资产列表不完整，已停止同步");
    const assets = parseKoiosAssets(row.asset_list);
    utxos.push({ txHash: row.tx_hash, txIndex: row.tx_index, lovelace: BigInt(row.value), assets, address: row.address, derivationIndex: derivation.index });
    for (const asset of assets) {
      const key = `${asset.policyId}.${asset.assetNameHex}`;
      const existing = balances.get(key);
      if (existing) existing.quantity += asset.quantity;
      else balances.set(key, { ...asset });
    }
  }
  const assetBalances = [...balances.values()].sort((a, b) => (a.policyId + a.assetNameHex < b.policyId + b.assetNameHex ? -1 : 1));
  type TxIo = { value: string; payment_addr?: { bech32?: string | null } | null; asset_list?: unknown[] | null };
  type TxDetail = {
    tx_hash: string;
    fee?: string;
    inputs?: TxIo[] | null;
    outputs?: TxIo[] | null;
  };
  const details: TxDetail[] = [];
  for (let i = 0; i < transactionRows.length; i += 25) {
    const requested = new Set(transactionRows.slice(i, i + 25).map((row) => row.tx_hash));
    const batch = await request<TxDetail[]>(network, "/tx_info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
      _tx_hashes: [...requested],
      _inputs: true,
      _metadata: false,
      _assets: true,
      _withdrawals: false,
      _certs: false,
      _scripts: false,
      _bytecode: false,
      _governance: false,
      }),
      signal,
    });
    if (!Array.isArray(batch) || batch.length !== requested.size ||
        batch.some((detail) => !detail || typeof detail.tx_hash !== "string" || !requested.delete(detail.tx_hash)))
      throw new Error("Koios 返回的交易详情不完整或重复，已停止同步");
    details.push(...batch);
  }
  const detailByHash = new Map(details.map((detail) => [detail.tx_hash, detail]));
  if (transactionRows.some((row) => !detailByHash.has(row.tx_hash)))
    throw new Error("Koios 缺少部分交易详情，已停止同步");
  const transactions: WalletTransaction[] = transactionRows.map((row) => {
    const detail = detailByHash.get(row.tx_hash);
    const parseSides = (items: TxIo[] | null | undefined): TransactionSide[] => {
      if (!Array.isArray(items)) throw new Error("Koios 交易输入输出不完整");
      return items.map((item) => {
        if (!item || !/^\d+$/.test(item.value) || !Array.isArray(item.asset_list))
          throw new Error("Koios 交易资产数据无效");
        const address = typeof item.payment_addr?.bech32 === "string" ? item.payment_addr.bech32 : null;
        return { address, owned: walletAddresses.has(address ?? ""), lovelace: BigInt(item.value), assets: parseKoiosAssets(item.asset_list) };
      });
    };
    const inputs = parseSides(detail?.inputs);
    const outputs = parseSides(detail?.outputs);
    const assetNet = new Map<string, bigint>();
    const sumOwned = (items: TransactionSide[], sign: bigint) => items.reduce((sum, item) => {
      if (!item.owned) return sum;
      for (const asset of item.assets) {
        const key = `${asset.policyId}.${asset.assetNameHex}`;
        assetNet.set(key, (assetNet.get(key) ?? 0n) + sign * asset.quantity);
      }
      return sum + sign * item.lovelace;
    }, 0n);
    const netLovelace = sumOwned(outputs, 1n) + sumOwned(inputs, -1n);
    const assets = [...assetNet].filter(([, quantity]) => quantity !== 0n).map(([key, quantity]) => {
      const [policyId, assetNameHex] = key.split(".");
      return { policyId, assetNameHex, quantity };
    });
    const amounts = [netLovelace, ...assets.map((asset) => asset.quantity)];
    const direction: WalletTransaction["direction"] = amounts.some((amount) => amount > 0n) && amounts.some((amount) => amount < 0n)
      ? "mixed" : amounts.some((amount) => amount < 0n) ? "sent" : "received";
    const feeLovelace = /^\d+$/.test(detail?.fee ?? "") ? BigInt(detail!.fee!) : null;
    return { txHash: row.tx_hash, blockHeight: row.block_height, blockTime: row.block_time, feeLovelace,
      direction, netLovelace, assets, inputs, outputs };
  }).sort((a, b) => b.blockTime - a.blockTime);
  return { utxos, assetBalances, usedAddresses: [...new Set(outputs.map((output) => output.address))], transactions };
}

// Resolve display metadata for held assets. Koios returns rows only for assets
// that have registry or minting metadata; callers fall back to fingerprints.
async function fetchAssetInfoFrom(network: CardanoNetwork, units: Array<{ policyId: string; assetNameHex: string }>, source: DataSource = "koios") {
  const { request } = apiFor(source);
  if (!units.length) return [];
  const chunks: Array<typeof units> = [];
  for (let i = 0; i < units.length; i += 25) chunks.push(units.slice(i, i + 25));
  const rows: AssetInfoRow[] = [];
  for (const chunk of chunks) {
    const batch = await request<AssetInfoRow[]>(network, "/asset_info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _asset_list: chunk.map((unit) => [unit.policyId, unit.assetNameHex]) }),
    });
    if (Array.isArray(batch)) rows.push(...batch);
  }
  return rows;
}

export { resolveAssetMeta };

export type StakingState = {
  registered: boolean;
  delegatedPool: string | null;
  rewardsLovelace: bigint;
  rewardsTotalLovelace: bigint | null;
  withdrawalsTotalLovelace: bigint | null;
  depositLovelace: bigint | null;
};

async function fetchStakingStateFrom(network: CardanoNetwork, stakeAddress: string, source: DataSource = "koios"): Promise<StakingState> {
  const { request } = apiFor(source);
  const rows = await request<Array<Record<string, unknown>>>(network, "/account_info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
  });
  if (!Array.isArray(rows) || rows.some((entry) => !entry || entry.stake_address !== stakeAddress) || rows.length > 1)
    throw new Error("Koios 返回的质押账户信息无效，已停止质押操作");
  const row = rows[0];
  if (!row) return { registered: false, delegatedPool: null, rewardsLovelace: 0n,
    rewardsTotalLovelace: 0n, withdrawalsTotalLovelace: 0n, depositLovelace: null };
  const rewards = row.rewards_available;
  const rewardsTotal = row.rewards ?? row.rewards_sum;
  const withdrawalsTotal = row.withdrawals ?? row.withdrawals_sum;
  const delegated = row.delegated_pool;
  const deposit = row.deposit;
  const registered = row.status === "registered";
  if ((!registered && row.status !== "not registered" && row.status !== "not_registered") ||
      typeof rewards !== "string" || !/^\d+$/.test(rewards) ||
      (rewardsTotal !== null && rewardsTotal !== undefined && (typeof rewardsTotal !== "string" || !/^\d+$/.test(rewardsTotal))) ||
      (withdrawalsTotal !== null && withdrawalsTotal !== undefined && (typeof withdrawalsTotal !== "string" || !/^\d+$/.test(withdrawalsTotal))) ||
      (delegated !== null && delegated !== undefined && (typeof delegated !== "string" || !delegated.startsWith("pool1"))) ||
      (registered && (typeof deposit !== "string" || !/^\d+$/.test(deposit))) ||
      (deposit !== null && deposit !== undefined && (typeof deposit !== "string" || !/^\d+$/.test(deposit))))
    throw new Error("Koios 返回的质押账户信息无效，已停止质押操作");
  return {
    registered,
    delegatedPool: typeof delegated === "string" ? delegated : null,
    rewardsLovelace: BigInt(rewards),
    rewardsTotalLovelace: typeof rewardsTotal === "string" ? BigInt(rewardsTotal) : null,
    withdrawalsTotalLovelace: typeof withdrawalsTotal === "string" ? BigInt(withdrawalsTotal) : null,
    depositLovelace: typeof deposit === "string" && /^\d+$/.test(deposit) ? BigInt(deposit) : null,
  };
}

export type PoolInfo = {
  poolId: string;
  ticker: string | null;
  name: string | null;
  margin: number | null;
  fixedCostLovelace: string | null;
  saturation: number | null;
  liveStakeLovelace: string | null;
  retiringEpoch: number | null;
  status: string | null;
};

async function fetchPoolInfoFrom(network: CardanoNetwork, poolId: string, source: DataSource = "koios"): Promise<PoolInfo | null> {
  const { request } = apiFor(source);
  const rows = await request<Array<Record<string, unknown>>>(network, "/pool_info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ _pool_bech32_ids: [poolId] }),
  });
  const row = rows.find((entry) => entry.pool_id_bech32 === poolId);
  if (!row) return null;
  const meta = typeof row.meta_json === "object" && row.meta_json ? row.meta_json as Record<string, unknown> : {};
  const asString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
  const saturation = typeof row.live_saturation === "number" ? row.live_saturation : null;
  return {
    poolId,
    ticker: asString(meta.ticker),
    name: asString(meta.name),
    margin: typeof row.margin === "number" ? row.margin : null,
    fixedCostLovelace: typeof row.fixed_cost === "string" ? row.fixed_cost : null,
    saturation: saturation !== null && saturation >= 0 && saturation <= 10 ? saturation : null,
    liveStakeLovelace: typeof row.live_stake === "string" ? row.live_stake : null,
    retiringEpoch: typeof row.retiring_epoch === "number" ? row.retiring_epoch : null,
    status: asString(row.pool_status),
  };
}

async function fetchChainContextFrom(network: CardanoNetwork, signal?: AbortSignal, source: DataSource = "koios") {
  const { request } = apiFor(source);
  const params = await request<{ txFeePerByte: number; txFeeFixed: number; utxoCostPerByte: number; stakeAddressDeposit: number }>(network, "/cli_protocol_params", { signal });
  const tip = await request<Array<{ abs_slot: unknown }>>(network, "/tip", { signal });
  const slot = tip?.[0]?.abs_slot;
  const validSlot = (typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0) ||
    (typeof slot === "string" && /^[0-9]+$/.test(slot) && BigInt(slot) <= BigInt(Number.MAX_SAFE_INTEGER));
  if (!params || !Number.isSafeInteger(params.txFeePerByte) || params.txFeePerByte < 1 || params.txFeePerByte > 10_000 ||
      !Number.isSafeInteger(params.txFeeFixed) || params.txFeeFixed < 1 || params.txFeeFixed > 5_000_000 ||
      !Number.isSafeInteger(params.utxoCostPerByte) || params.utxoCostPerByte < 1 || params.utxoCostPerByte > 1_000_000 ||
      !Number.isSafeInteger(params.stakeAddressDeposit) || params.stakeAddressDeposit < 0 || params.stakeAddressDeposit > 1_000_000_000 ||
      !Array.isArray(tip) || !validSlot)
    throw new Error("Koios 返回的链参数无效，已停止构造交易");
  return { protocol: params, tipSlot: BigInt(slot as number | string) };
}

export async function broadcast(txHex: string, network: CardanoNetwork): Promise<string> {
  const expectedHash = transactionId(txHex);
  const bytes = Uint8Array.from(txHex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  if (activeSource(network) === "blockfrost") {
    const reported = await bfRequest(network, "/tx/submit", undefined, bytes);
    if (reported !== expectedHash) throw new Error("广播接口返回的交易 ID 与本地计算结果不一致，请通过 TXID 查询链上状态后再操作");
    return expectedHash;
  }
  const response = await fetch(`${networkConfig(network).apiPrefix}/submittx`, {
    method: "POST",
    headers: { "Content-Type": "application/cbor" },
    body: bytes,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`广播失败 (${response.status}): ${text}`);
  const reportedHash = text.replaceAll('"', "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(reportedHash) || reportedHash !== expectedHash)
    throw new Error("广播接口返回的交易 ID 与本地计算结果不一致，请通过 TXID 查询链上状态后再操作");
  return reportedHash;
}

export const fetchWallet = (addresses: DerivedAddress[], network: CardanoNetwork, signal?: AbortSignal) =>
  withSource(network, (source) => fetchWalletFrom(addresses, network, signal, source));
export const fetchAssetInfo = (network: CardanoNetwork, units: Array<{ policyId: string; assetNameHex: string }>) =>
  withSource(network, (source) => fetchAssetInfoFrom(network, units, source));
export const fetchStakingState = (network: CardanoNetwork, address: string) =>
  withSource(network, (source) => fetchStakingStateFrom(network, address, source));
export const fetchPoolInfo = (network: CardanoNetwork, id: string) =>
  withSource(network, (source) => fetchPoolInfoFrom(network, id, source));
export const fetchChainContext = (network: CardanoNetwork, signal?: AbortSignal) =>
  withSource(network, (source) => fetchChainContextFrom(network, signal, source));

// Compare transaction-critical data without downloading either provider's history.
export async function verifyPackageSources(
  pkg: import("./types").UnsignedPackage,
  descriptor: import("./types").Descriptor,
  localUtxos: Utxo[],
  stake?: import("./cardano").StakingContext,
): Promise<boolean> {
  const settings = sourceSettings();
  if (!settings.verify || !settings[pkg.network]) return false;
  if (descriptor.network !== pkg.network) throw new Error("双源核验网络不一致");
  const inputAddresses = [...new Set(pkg.inputs.map((input) => input.address))];
  const local = new Map(localUtxos.map((utxo) => [`${utxo.txHash}#${utxo.txIndex}`, utxo]));
  const valueKey = (value: bigint, assets: AssetUnit[]) => JSON.stringify([value.toString(),
    [...assets].sort((a, b) => (a.policyId + a.assetNameHex).localeCompare(b.policyId + b.assetNameHex))
      .map((a) => [a.policyId, a.assetNameHex, a.quantity.toString()])]);
  const snapshots = await Promise.all((["koios", "blockfrost"] as const).map(async (source) => {
    const rows: Array<{ tx_hash: string; tx_index: number; address: string; value: string; asset_list: unknown }> = [];
    for (const batch of addressBatches(inputAddresses)) rows.push(...await requestAll<typeof rows[number]>(pkg.network,
      "/address_utxos", { _addresses: batch, _extended: true }, undefined, source));
    const seen = new Set<string>();
    const byRef = new Map<string, typeof rows[number]>();
    for (const entry of rows) {
      if (!entry || !/^[0-9a-f]{64}$/.test(entry.tx_hash) || !Number.isSafeInteger(entry.tx_index) || entry.tx_index < 0 ||
          !inputAddresses.includes(entry.address) || typeof entry.value !== "string" || !/^\d+$/.test(entry.value) || !Array.isArray(entry.asset_list))
        throw new Error("双源核验返回了无效 UTXO，已停止交易");
      const ref = `${entry.tx_hash}#${entry.tx_index}`;
      if (seen.has(ref)) throw new Error("双源核验发现重复 UTXO，已停止交易");
      seen.add(ref); byRef.set(ref, entry);
    }
    for (const input of pkg.inputs) {
      const ref = `${input.txHash}#${input.txIndex}`;
      const remote = byRef.get(ref), expected = local.get(ref);
      if (!remote || !expected || remote.address !== expected.address ||
          valueKey(BigInt(remote.value), parseKoiosAssets(remote.asset_list)) !== valueKey(expected.lovelace, expected.assets ?? []))
        throw new Error("双源核验的输入 UTXO 不一致或已花费，请重新同步；已停止交易");
    }
    const chain = await fetchChainContextFrom(pkg.network, undefined, source);
    const staking = pkg.version === 3
      ? await fetchStakingStateFrom(pkg.network, rewardAddressOf(descriptor), source) : null;
    return { chain, staking };
  }));
  const [a, b] = snapshots;
  const tip = a.chain.tipSlot > b.chain.tipSlot ? a.chain.tipSlot : b.chain.tipSlot;
  const ttl = BigInt(inspectFinalTransaction(pkg.txCborHex).ttl ?? "0");
  if (ttl <= tip || ttl > tip + 3600n) throw new Error("签名包有效期已过或超出一小时安全窗口，请重新构建交易");
  if ((["txFeePerByte", "txFeeFixed", "utxoCostPerByte", "stakeAddressDeposit"] as const).some((key) => a.chain.protocol[key] !== b.chain.protocol[key]) ||
      (a.chain.tipSlot > b.chain.tipSlot ? a.chain.tipSlot - b.chain.tipSlot : b.chain.tipSlot - a.chain.tipSlot) > 180n)
    throw new Error("双源链参数或最新区块时隙不一致，请稍后重试；已停止交易");
  if (pkg.version === 3) {
    const left = a.staking!, right = b.staking!;
    if (!stake || left.registered !== right.registered || left.delegatedPool !== right.delegatedPool ||
        left.rewardsLovelace !== right.rewardsLovelace || left.depositLovelace !== right.depositLovelace ||
        left.registered !== stake.registered || left.rewardsLovelace !== stake.rewardsLovelace ||
        (left.registered && left.depositLovelace !== stake.keyDeposit))
      throw new Error("双源质押状态不一致，请重新同步；已停止交易");
  }
  return true;
}
