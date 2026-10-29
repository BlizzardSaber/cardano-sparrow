import type { CardanoNetwork } from "./network";
import { sourceSettings, SourceHttpError } from "./data-source";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Blockfrost 数据格式无效"); return v as Row; };
const list = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Error("Blockfrost 列表不完整"); return v; };
const integer = (v: unknown): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("Blockfrost 整数无效"); return v as number; };
const decimal = (v: unknown): string => { if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("Blockfrost 金额无效"); return v; };
const hash = (v: unknown): string => { if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new Error("Blockfrost 交易 ID 无效"); return v; };
export async function bfRequest(network: CardanoNetwork, path: string, signal?: AbortSignal, body?: Uint8Array): Promise<unknown> {
  const key = sourceSettings()[network];
  if (!key) throw new Error("请先配置当前网络的 Blockfrost Project ID");
  let response: Response;
  try { response = await fetch(`/blockfrost-${network}/api/v0${path}`, {
    method: body ? "POST" : "GET", headers: { project_id: key, ...(body ? { "Content-Type": "application/cbor" } : {}) },
    body: body as BodyInit | undefined, signal,
  }); } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SourceHttpError("blockfrost", 0);
  }
  if (!response.ok) throw new SourceHttpError("blockfrost", response.status);
  return response.json();
}
async function optional(network: CardanoNetwork, path: string, signal?: AbortSignal) {
  try { return await bfRequest(network, path, signal); }
  catch (e) { if (e instanceof SourceHttpError && e.status === 404) return null; throw e; }
}
async function mapLimit<T>(items: T[], run: (item: T) => Promise<unknown>): Promise<unknown[]> {
  let next = 0, failed = false; const results: unknown[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { results[i] = await run(items[i]); } catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
export function bfAmounts(value: unknown) {
  let lovelace: string | undefined;
  const assets: Array<{ policy_id: string; asset_name: string; quantity: string }> = [];
  const seen = new Set<string>();
  for (const valueItem of list(value)) {
    const item = row(valueItem); const unit = item.unit; const quantity = decimal(item.quantity);
    if (typeof unit !== "string" || seen.has(unit)) throw new Error("Blockfrost 资产单位无效或重复");
    seen.add(unit);
    if (unit === "lovelace") lovelace = quantity;
    else {
      if (!/^[0-9a-f]{56}([0-9a-f]{2}){0,32}$/.test(unit) || BigInt(quantity) <= 0n) throw new Error("Blockfrost 资产单位无效");
      assets.push({ policy_id: unit.slice(0, 56), asset_name: unit.slice(56), quantity });
    }
  }
  if (lovelace === undefined) throw new Error("Blockfrost 缺少 ADA 金额");
  return { value: lovelace, asset_list: assets };
}
export async function bfAddressUtxos(network: CardanoNetwork, address: string, signal?: AbortSignal) {
  const result: Row[] = []; const seen = new Set<string>();
  for (let page = 1; page <= 500; page++) {
    const response = await optional(network, `/addresses/${address}/utxos?count=100&page=${page}&order=asc`, signal);
    if (response === null && page === 1) return [];
    const rows = list(response);
    if (rows.length > 100) throw new Error("Blockfrost 分页无效");
    for (const value of rows) {
      const item = row(value); const txHash = hash(item.tx_hash); const index = integer(item.output_index);
      const ref = `${txHash}#${index}`;
      if (seen.has(ref) || item.address !== address)
        throw new Error("Blockfrost UTXO 重复、地址不符或包含不支持的脚本数据");
      seen.add(ref);
      result.push({ tx_hash: txHash, tx_index: index, address, ...bfAmounts(item.amount) });
    }
    if (rows.length < 100) return result;
  }
  throw new Error("Blockfrost UTXO 超出安全分页上限");
}
export async function bfAccount(network: CardanoNetwork, address: string, signal?: AbortSignal): Promise<Row[]> {
  const response = await optional(network, `/accounts/${address}`, signal);
  if (response === null) return [];
  const account = row(response);
  if (account.stake_address !== address || typeof account.registered !== "boolean" ||
      (account.pool_id !== null && (typeof account.pool_id !== "string" || !/^pool1[a-z0-9]+$/.test(account.pool_id))))
    throw new Error("Blockfrost 质押账户无效");
  const rewards = decimal(account.withdrawable_amount);
  const rewardsTotal = account.rewards_sum == null ? null : decimal(account.rewards_sum);
  const withdrawalsTotal = account.withdrawals_sum == null ? null : decimal(account.withdrawals_sum);
  let deposit: string | null = null;
  if (account.registered) {
    const regs = list(await bfRequest(network, `/accounts/${address}/registrations?count=1&page=1&order=desc`, signal));
    if (regs.length !== 1 || row(regs[0]).action !== "registered") throw new Error("Blockfrost 质押注册记录不完整");
    deposit = decimal(row(regs[0]).deposit);
  }
  return [{ stake_address: address, status: account.registered ? "registered" : "not registered",
    rewards_available: rewards, rewards_sum: rewardsTotal, withdrawals_sum: withdrawalsTotal,
    deposit, delegated_pool: account.pool_id }];
}
export async function bfResponse(network: CardanoNetwork, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, "https://local.invalid");
  const signal = init?.signal ?? undefined;
  const data = init?.body ? row(JSON.parse(String(init.body))) : {};
  const addresses = Array.isArray(data._addresses) ? data._addresses.map(String) : [];
  let result: unknown;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  switch (url.pathname) {
    case "/address_utxos": {
      const rows = (await mapLimit(addresses, (address) => bfAddressUtxos(network, address, signal))).flat() as Row[];
      if (rows.length > 50_000) throw new Error("Blockfrost UTXO 超出安全分页上限");
      rows.sort((a, b) => String(a.tx_hash).localeCompare(String(b.tx_hash)) || Number(a.tx_index) - Number(b.tx_index));
      const range = new Headers(init?.headers).get("Range")?.match(/^(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0; const end = range ? Number(range[2]) : rows.length - 1;
      result = rows.slice(start, end + 1);
      headers["Content-Range"] = (result as unknown[]).length ? `${start}-${start + (result as unknown[]).length - 1}/${rows.length}` : `*/${rows.length}`;
      break;
    }
    case "/address_info":
      result = (await mapLimit(addresses, async (address) => {
        const found = await optional(network, `/addresses/${address}`, signal);
        if (found === null) return [];
        if (row(found).address !== address) throw new Error("Blockfrost 地址信息不符");
        return [{ address }];
      })).flat(); break;
    case "/address_txs": {
      const rows = (await mapLimit(addresses, async (address) => {
        const response = await optional(network, `/addresses/${address}/transactions?count=100&page=1&order=desc`, signal);
        const values = response === null ? [] : list(response);
        if (values.length > 100) throw new Error("Blockfrost 交易列表无效");
        return values.map((value) => { const tx = row(value); return { tx_hash: hash(tx.tx_hash), block_height: integer(tx.block_height), block_time: integer(tx.block_time) }; });
      })).flat() as Array<{ tx_hash: string; block_height: number; block_time: number }>;
      result = [...new Map(rows.map((tx) => [tx.tx_hash, tx])).values()]
        .sort((a, b) => b.block_height - a.block_height || b.tx_hash.localeCompare(a.tx_hash)).slice(0, 100); break;
    }
    case "/tx_info":
      result = await mapLimit(list(data._tx_hashes), async (id) => {
        const txHash = hash(id);
        const [txValue, ioValue] = await Promise.all([bfRequest(network, `/txs/${txHash}`, signal), bfRequest(network, `/txs/${txHash}/utxos`, signal)]);
        const tx = row(txValue), io = row(ioValue);
        if (tx.hash !== txHash || io.hash !== txHash || typeof tx.valid_contract !== "boolean") throw new Error("Blockfrost 交易详情不符");
        const sides = (values: unknown) => list(values).map(row)
          .filter((v) => !v.reference && (tx.valid_contract ? !v.collateral : v.collateral === true))
          .map((v) => { if (typeof v.address !== "string") throw new Error("Blockfrost 交易地址缺失"); return { payment_addr: { bech32: v.address }, ...bfAmounts(v.amount) }; });
        return { tx_hash: txHash, fee: decimal(tx.fees), inputs: sides(io.inputs), outputs: sides(io.outputs) };
      }); break;
    case "/cli_protocol_params": {
      const p = row(await bfRequest(network, "/epochs/latest/parameters", signal));
      result = { txFeePerByte: integer(p.min_fee_a), txFeeFixed: integer(p.min_fee_b),
        utxoCostPerByte: Number(decimal(p.coins_per_utxo_size)), stakeAddressDeposit: Number(decimal(p.key_deposit)) }; break;
    }
    case "/tip": { const tip = row(await bfRequest(network, "/blocks/latest", signal)); result = [{ abs_slot: integer(tip.slot) }]; break; }
    case "/account_info": result = await bfAccount(network, String(list(data._stake_addresses)[0]), signal); break;
    case "/asset_info":
      result = (await mapLimit(list(data._asset_list), async (unit) => {
        const [policy, name] = list(unit).map(String);
        const info = await optional(network, `/assets/${policy}${name}`, signal);
        return info === null ? [] : [{ policy_id: policy, asset_name: name, token_registry_metadata: row(info).metadata }];
      })).flat(); break;
    case "/pool_info": {
      const id = String(list(data._pool_bech32_ids)[0]);
      const found = await optional(network, `/pools/${id}`, signal);
      if (found === null) { result = []; break; }
      const p = row(found); if (p.pool_id !== id) throw new Error("Blockfrost 质押池不符");
      const meta = await optional(network, `/pools/${id}/metadata`, signal);
      result = [{ pool_id_bech32: id, meta_json: meta, margin: p.margin_cost, fixed_cost: p.fixed_cost,
        live_saturation: p.live_saturation, live_stake: p.live_stake, retiring_epoch: null, pool_status: null }]; break;
    }
    default: throw new Error("不支持的 Blockfrost 操作");
  }
  return new Response(JSON.stringify(result), { status: 200, headers });
}
