import { bech32 } from "bech32";
import * as C from "@emurgo/cardano-serialization-lib-browser";
import { addLedgerWitnesses, validateUnsignedPackage, type LedgerSigner } from "./cardano";
import type {
  AssetGroup, Certificate, CredentialParams, SignTransactionRequest, Token,
  TransactionSigningMode, TxOutput, TxOutputDestinationType, TxOutputFormat, Withdrawal,
} from "@cardano-foundation/ledgerjs-hw-app-cardano";
import { CertificateType, CredentialParamsType } from "@cardano-foundation/ledgerjs-hw-app-cardano";
import type { UnsignedPackage } from "./types";
import { networkConfig } from "./network";
import { bytesToHex } from "./fingerprint";

const HARDENED = 0x80000000;
export const CIP1854_ACCOUNT_PATH = [1854 + HARDENED, 1815 + HARDENED, HARDENED] as const;

export function encodeAccountXpub(publicKeyHex: string, chainCodeHex: string) {
  const bytes = Uint8Array.from(BufferlessHex.toBytes(publicKeyHex + chainCodeHex));
  if (bytes.length !== 64) throw new Error("Ledger 返回的扩展公钥长度无效");
  return bech32.encode("acct_shared_xvk", bech32.toWords(bytes), 200);
}

export function resolvePackageConstructor<T>(module: unknown, name: string): T {
  let current = module;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === "function") return current as T;
    if (!current || typeof current !== "object") break;
    const exports = current as Record<string, unknown>;
    if (typeof exports[name] === "function") return exports[name] as T;
    current = exports.default;
  }
  throw new Error(`无法加载 Ledger ${name} 模块`);
}

export function ledgerRequestFromPackage(pkgValue: unknown): SignTransactionRequest {
  const pkg = validateUnsignedPackage(pkgValue);
  const tx = C.Transaction.from_hex(pkg.txCborHex);
  const body = tx.body();
  const network = networkConfig(pkg.network);
  if (tx.auxiliary_data() || body.auxiliary_data_hash() || body.mint() ||
      body.validity_start_interval_bignum() || body.script_data_hash() || body.collateral() || body.required_signers() ||
      body.collateral_return() || body.total_collateral() || body.reference_inputs() || body.voting_procedures() ||
      body.current_treasury_value() || body.donation())
    throw new Error("当前 Ledger 签名仅支持本原型生成的 ADA、原生资产与质押交易");
  const bodyCerts = body.certs();
  const certificates: Certificate[] = [];
  if (bodyCerts) {
    for (let i = 0; i < bodyCerts.len(); i++) {
      const cert = bodyCerts.get(i);
      const kind = cert.kind();
      if (kind === C.CertificateKind.StakeRegistration) {
        const credential = cert.as_stake_registration()!.stake_credential();
        if (!credential.has_script_hash()) throw new Error("质押证书必须使用脚本质押凭证");
        certificates.push({ type: CertificateType.STAKE_REGISTRATION, params: { stakeCredential: scriptCredential(credential) } });
      } else if (kind === C.CertificateKind.StakeDeregistration) {
        const credential = cert.as_stake_deregistration()!.stake_credential();
        if (!credential.has_script_hash()) throw new Error("质押证书必须使用脚本质押凭证");
        certificates.push({ type: CertificateType.STAKE_DEREGISTRATION, params: { stakeCredential: scriptCredential(credential) } });
      } else if (kind === C.CertificateKind.StakeDelegation) {
        const delegation = cert.as_stake_delegation()!;
        const credential = delegation.stake_credential();
        if (!credential.has_script_hash()) throw new Error("质押证书必须使用脚本质押凭证");
        certificates.push({ type: CertificateType.STAKE_DELEGATION, params: { stakeCredential: scriptCredential(credential), poolKeyHashHex: delegation.pool_keyhash().to_hex() } });
      } else {
        throw new Error("当前 Ledger 签名不支持该质押证书类型");
      }
    }
  }
  const bodyWithdrawals = body.withdrawals();
  const withdrawals: Withdrawal[] = [];
  if (bodyWithdrawals) {
    for (let i = 0; i < bodyWithdrawals.len(); i++) {
      const rewardAddress = bodyWithdrawals.keys().get(i);
      const credential = rewardAddress.payment_cred();
      if (!credential.has_script_hash()) throw new Error("提款必须使用脚本质押凭证");
      withdrawals.push({ stakeCredential: scriptCredential(credential), amount: bodyWithdrawals.get(rewardAddress)!.to_str() });
    }
  }

  const inputs = body.inputs();
  const outputs = body.outputs();
  return {
    signingMode: "multisig_transaction" as TransactionSigningMode,
    tx: {
      network: { networkId: network.networkId, protocolMagic: network.protocolMagic },
      inputs: Array.from({ length: inputs.len() }, (_, index) => {
        const input = inputs.get(index);
        return { txHashHex: input.transaction_id().to_hex(), outputIndex: input.index(), path: null };
      }),
      outputs: Array.from({ length: outputs.len() }, (_, index) => {
        const output = outputs.get(index);
        if (output.data_hash() || output.plutus_data() || output.script_ref())
          throw new Error("当前 Ledger 签名不支持 Datum 或 reference script 输出");
        const amount = output.amount();
        const multiAsset = amount.multiasset();
        const tokenBundle: AssetGroup[] = [];
        if (multiAsset) {
          const policies = multiAsset.keys();
          for (let i = 0; i < policies.len(); i++) {
            const policy = policies.get(i);
            const assets = multiAsset.get(policy)!;
            const names = assets.keys();
            const tokens: Token[] = [];
            for (let j = 0; j < names.len(); j++) {
              const name = names.get(j);
              tokens.push({ assetNameHex: bytesToHex(name.name()), amount: assets.get(name)!.to_str() });
            }
            tokenBundle.push({ policyIdHex: bytesToHex(policy.to_bytes()), tokens });
          }
          tokenBundle.sort((a, b) => (a.policyIdHex < b.policyIdHex ? -1 : 1));
        }
        return {
          format: (output.serialization_format() === C.CborContainerType.Map ? 1 : 0) as TxOutputFormat,
          destination: {
            type: "third_party" as TxOutputDestinationType,
            params: { addressHex: bytesToHex(output.address().to_bytes()) },
          },
          amount: amount.coin().to_str(),
          ...(tokenBundle.length ? { tokenBundle } : {}),
        } as TxOutput;
      }),
      fee: body.fee().to_str(),
      ttl: body.ttl_bignum()?.to_str() ?? null,
      includeNetworkId: body.network_id() !== undefined,
      ...(certificates.length ? { certificates } : {}),
      ...(withdrawals.length ? { withdrawals } : {}),
    },
    additionalWitnessPaths: pkg.signingPaths.map(parsePath),
    options: { tagCborSets: true },
  };
}

export class LedgerWebHidSigner implements LedgerSigner {
  readonly name = "Ledger WebHID";

  isSupported() {
    return typeof navigator !== "undefined" && "hid" in navigator;
  }

  async getAccountXpub(account = 0) {
    if (!this.isSupported()) throw new Error("当前浏览器不支持 WebHID，请使用 Chrome、Edge 或桌面壳");
    if (!Number.isInteger(account) || account < 0 || account >= HARDENED) throw new Error("Ledger 账户序号无效");

    const [transportModule, cardanoModule] = await Promise.all([
      import("@ledgerhq/hw-transport-webhid"),
      import("@cardano-foundation/ledgerjs-hw-app-cardano"),
    ]);
    const TransportWebHID = resolvePackageConstructor<typeof import("@ledgerhq/hw-transport-webhid").default>(transportModule, "TransportWebHID");
    const Ada = resolvePackageConstructor<typeof import("@cardano-foundation/ledgerjs-hw-app-cardano").default>(cardanoModule, "Ada");
    const transport = await TransportWebHID.create();
    try {
      const app = new Ada(transport);
      const result = await app.getExtendedPublicKey({
        path: [CIP1854_ACCOUNT_PATH[0], CIP1854_ACCOUNT_PATH[1], account + HARDENED],
      });
      return encodeAccountXpub(result.publicKeyHex, result.chainCodeHex);
    } finally {
      await transport.close();
    }
  }

  async signTransaction(_request: UnsignedPackage): Promise<string> {
    const request = validateUnsignedPackage(_request);
    if (!this.isSupported()) throw new Error("当前浏览器不支持 WebHID，请使用 Chrome、Edge 或桌面壳");
    const [transportModule, cardanoModule] = await Promise.all([
      import("@ledgerhq/hw-transport-webhid"),
      import("@cardano-foundation/ledgerjs-hw-app-cardano"),
    ]);
    const TransportWebHID = resolvePackageConstructor<typeof import("@ledgerhq/hw-transport-webhid").default>(transportModule, "TransportWebHID");
    const Ada = resolvePackageConstructor<typeof import("@cardano-foundation/ledgerjs-hw-app-cardano").default>(cardanoModule, "Ada");
    const transport = await TransportWebHID.create();
    try {
      const app = new Ada(transport);
      const { compatibility } = await app.getVersion();
      if (!compatibility.supportsMultisigTransaction)
        throw new Error(`Ledger Cardano App 版本过旧，请升级到 ${compatibility.recommendedVersion ?? "最新版"}`);
      const key = await app.getExtendedPublicKey({ path: [...CIP1854_ACCOUNT_PATH] });
      const accountXpub = encodeAccountXpub(key.publicKeyHex, key.chainCodeHex);
      const signed = await app.signTransaction(ledgerRequestFromPackage(request));
      if (signed.txHashHex !== request.txBodyHashHex) throw new Error("Ledger 返回的 transaction ID 与待签交易不一致");
      return addLedgerWitnesses(request, accountXpub, signed.witnesses);
    } finally {
      await transport.close();
    }
  }
}

function parsePath(value: string) {
  const match = value.match(/^m\/1854'\/1815'\/0'\/(0|2)\/(\d+)$/);
  if (!match || (match[1] === "2" && match[2] !== "0")) throw new Error("签名包不是受支持的 CIP-1854 M-of-N 交易");
  return [CIP1854_ACCOUNT_PATH[0], CIP1854_ACCOUNT_PATH[1], CIP1854_ACCOUNT_PATH[2], Number(match[1]), Number(match[2])];
}

function scriptCredential(credential: C.Credential): CredentialParams {
  return { type: CredentialParamsType.SCRIPT_HASH, scriptHashHex: credential.to_scripthash()!.to_hex() };
}

const BufferlessHex = {
  toBytes(hex: string) {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error("Ledger 返回了无效十六进制数据");
    return hex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16));
  },
};
