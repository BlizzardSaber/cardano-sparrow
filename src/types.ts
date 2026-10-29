import type { CardanoNetwork } from "./network";

export type Descriptor = {
  format: "cardano-hd-multisig";
  version: 1;
  network: CardanoNetwork;
  threshold: number;
  account: 0;
  gapLimit: number;
  cosigners: Cosigner[];
};

export type Cosigner = { name: string; accountXpub: string };

export type DerivedAddress = {
  index: number;
  address: string;
  scriptCborHex: string;
  keyHashes: string[];
};

// One native-asset unit held inside a UTXO. quantity is the on-chain integer.
export type AssetUnit = { policyId: string; assetNameHex: string; quantity: bigint };

export type Utxo = {
  txHash: string;
  txIndex: number;
  lovelace: bigint;
  /** Native assets held by this UTXO; absent means pure ADA. */
  assets?: AssetUnit[];
  address: string;
  derivationIndex: number;
};

export type WalletTransaction = {
  txHash: string;
  blockHeight: number;
  blockTime: number;
  feeLovelace: bigint | null;
  direction: "sent" | "received" | "mixed";
  netLovelace: bigint;
  assets: AssetUnit[];
  inputs: TransactionSide[];
  outputs: TransactionSide[];
};

export type TransactionSide = { address: string | null; owned: boolean; lovelace: bigint; assets: AssetUnit[] };

// JSON-facing asset amount inside signing-package outputs (strings keep bigint precision).
export type AssetQuantity = { policyId: string; assetNameHex: string; quantity: string };

// Staking certificate summary inside version-3 signing packages.
export type StakingCertificate =
  | { type: "register" }
  | { type: "delegate"; poolId: string }
  | { type: "deregister" };

export type UnsignedPackage = {
  format: "cardano-hd-multisig-tx";
  /** 1: pure ADA only. 2: outputs may carry native assets. 3: staking certificates/withdrawals allowed. */
  version: 1 | 2 | 3;
  network: CardanoNetwork;
  txCborHex: string;
  txBodyHashHex: string;
  inputs: Array<{ txHash: string; txIndex: number; address: string; derivationIndex: number }>;
  outputs: Array<{ address: string; lovelace: string; assets?: AssetQuantity[] }>;
  /** Present only in version-3 packages when the wallet performs a staking action. */
  certificates?: StakingCertificate[];
  withdrawalLovelace?: string;
  feeLovelace: string;
  requiredSignatures: number;
  signingPaths: string[];
};

// Display metadata resolved for a held asset (name/ticker/decimals/logo).
export type AssetMeta = {
  policyId: string;
  assetNameHex: string;
  fingerprint: string;
  name: string | null;
  ticker: string | null;
  decimals: number | null;
  logo: { kind: "url"; url: string } | { kind: "data"; url: string } | null;
  source: "registry" | "onchain" | "none";
};
