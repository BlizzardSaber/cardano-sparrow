import type { AssetMeta } from "./types";
import { assetFingerprint, assetNameText } from "./fingerprint";
import { isVerifiedNight } from "./prices";

export const USDCX_POLICY = "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34";
export const USDCX_NAME = "5553444378";

export function isUsdcx(policyId: string, assetNameHex: string): boolean {
  return policyId === USDCX_POLICY && assetNameHex === USDCX_NAME;
}

export function assetDecimals(policyId: string, assetNameHex: string, meta?: AssetMeta): number | null {
  return isVerifiedNight(policyId, assetNameHex) || isUsdcx(policyId, assetNameHex) ? 6 : meta?.decimals ?? null;
}

export function isListedAsset(policyId: string, assetNameHex: string, meta?: AssetMeta): boolean {
  return isVerifiedNight(policyId, assetNameHex) || isUsdcx(policyId, assetNameHex) || meta?.source === "registry";
}

// Koios /asset_info row. Only fields consumed by the resolver are declared;
// everything arrives as untrusted JSON and is validated before display.
export type AssetInfoRow = {
  policy_id?: unknown;
  asset_name?: unknown;
  asset_name_ascii?: unknown;
  fingerprint?: unknown;
  minting_tx_metadata?: unknown;
  token_registry_metadata?: unknown;
  cip68_metadata?: unknown;
};

const MEDIA_HOSTS_IPFS = "https://ipfs.io/ipfs/";

// Normalize logo sources: data URIs are used directly; ipfs/ar links go through
// the local icon proxy, which enforces scheme, DNS, size, and type limits.
function normalizeLogoSource(value: unknown): AssetMeta["logo"] {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return null;
  const uri = value.trim();
  if (/^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(uri))
    return { kind: "data", url: uri };
  if (/^data:/i.test(uri)) return null;
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^\/?(ipfs\/)?/, "");
    return path ? { kind: "url", url: `${MEDIA_HOSTS_IPFS}${path}` } : null;
  }
  if (uri.startsWith("ar://")) {
    const path = uri.slice("ar://".length).replace(/^\//, "");
    return /^[a-z0-9_-]+$/i.test(path) ? { kind: "url", url: `https://arweave.net/${path}` } : null;
  }
  if (uri.startsWith("https://")) return { kind: "url", url: uri };
  return null;
}

// CIP-25 v2 stores the logo as unprefixed base64 PNG bytes inside JSON metadata.
function base64Logo(value: unknown): AssetMeta["logo"] {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) return null;
  return { kind: "data", url: `data:image/png;base64,${value.replace(/\s+/g, "")}` };
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() && value.length <= 256 ? value.trim() : null;

function parseDecimals(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 18) return value;
  if (typeof value === "string" && /^\d{1,2}$/.test(value)) {
    const parsed = Number(value);
    return parsed <= 18 ? parsed : null;
  }
  return null;
}

type MetadataLike = Record<string, unknown>;

// CIP-25 minting metadata nests under {721: {policy: {assetKey: fields}}} and
// Koios may key the asset by its ASCII name; probe the known shapes defensively.
function findOnchainFields(row: AssetInfoRow, policyId: string, asciiName: string): MetadataLike | null {
  const minting = row.minting_tx_metadata;
  if (minting && typeof minting === "object") {
    const label721 = (minting as MetadataLike)["721"];
    if (label721 && typeof label721 === "object") {
      const policy = (label721 as MetadataLike)[policyId];
      if (policy && typeof policy === "object") {
        for (const [key, value] of Object.entries(policy as MetadataLike)) {
          if (value && typeof value === "object" && key.toLowerCase() === asciiName.toLowerCase()) return value as MetadataLike;
        }
      }
    }
  }
  const cip68 = row.cip68_metadata;
  if (cip68 && typeof cip68 === "object") {
    const entry = cip68 as MetadataLike;
    const policy68 = entry[policyId];
    if (policy68 && typeof policy68 === "object") {
      for (const [key, value] of Object.entries(policy68 as MetadataLike)) {
        if (value && typeof value === "object" && key.toLowerCase() === asciiName.toLowerCase()) return value as MetadataLike;
      }
    }
    if (asString(entry.name) || entry.files || entry.image || entry.logo) return entry;
  }
  return null;
}

function pickOnchainLogo(fields: MetadataLike | null): AssetMeta["logo"] {
  if (!fields) return null;
  const files = fields.files;
  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const entry = file as MetadataLike;
      const mediaType = asString(entry.mediaType);
      if (!mediaType?.startsWith("image/")) continue;
      const logo = normalizeLogoSource(entry.src) ?? (mediaType === "image/png" ? base64Logo(entry.src) : null);
      if (logo) return logo;
    }
  }
  for (const key of ["image", "logo", "icon", "img"]) {
    const direct = normalizeLogoSource(fields[key]);
    if (direct) return direct;
    if (key !== "image") {
      const asB64 = base64Logo(fields[key]);
      if (asB64) return asB64;
    }
  }
  return null;
}

export function resolveAssetMeta(policyId: string, assetNameHex: string, row: AssetInfoRow | undefined): AssetMeta {
  const fingerprint = assetFingerprint(policyId, assetNameHex);
  const asciiName = typeof row?.asset_name_ascii === "string" ? row.asset_name_ascii : assetNameText(assetNameHex);
  const meta: AssetMeta = {
    policyId,
    assetNameHex,
    fingerprint,
    name: null,
    ticker: null,
    decimals: null,
    logo: null,
    source: "none",
  };

  // The token registry sidecar is the most curated source when present.
  const registry = row?.token_registry_metadata;
  if (registry && typeof registry === "object") {
    const entry = registry as MetadataLike;
    const name = asString(entry.name);
    const ticker = asString(entry.ticker);
    const decimals = parseDecimals(entry.decimals);
    const logo = base64Logo(entry.logo) ?? normalizeLogoSource(entry.logo);
    if (name || ticker || decimals !== null || logo) {
      meta.name = name;
      meta.ticker = ticker;
      meta.decimals = decimals;
      meta.logo = logo;
      meta.source = "registry";
      return meta;
    }
  }

  const onchain = findOnchainFields(row ?? {}, policyId, asciiName || assetNameHex);
  const onchainLogo = pickOnchainLogo(onchain);
  const onchainName = onchain ? asString(onchain.name) : null;
  if (onchainName || onchainLogo) {
    meta.name = onchainName;
    meta.logo = onchainLogo;
    meta.source = "onchain";
    return meta;
  }

  return meta;
}

// Icon proxy URL for https logos; data URIs are used as-is by the renderer.
export function iconProxyUrl(logo: NonNullable<AssetMeta["logo"]>): string | null {
  if (logo.kind === "data") return logo.url;
  return `/asset-icon?u=${encodeURIComponent(logo.url)}`;
}

export function parseTokenAmount(text: string, decimals: number | null): bigint {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed) || trimmed.startsWith("00")) throw new Error("资产数量格式无效");
  const [whole, fraction = ""] = trimmed.split(".");
  const maxFraction = decimals ?? 0;
  if (fraction.length > maxFraction) {
    throw new Error(decimals === null
      ? "此资产没有可用的小数位信息，请输入整数数量"
      : `此资产最多 ${decimals} 位小数`);
  }
  const scaled = whole + fraction.padEnd(maxFraction, "0");
  const value = BigInt(scaled || "0");
  if (value <= 0n) throw new Error("资产数量必须大于零");
  return value;
}

export function formatTokenQuantity(quantity: bigint, decimals: number | null): string {
  if (decimals === null || decimals === 0) return quantity.toLocaleString("en-US");
  const scale = 10n ** BigInt(decimals);
  const whole = quantity / scale;
  const fraction = (quantity % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole.toLocaleString("en-US")}.${fraction}` : whole.toLocaleString("en-US");
}

export function formatTokenInput(quantity: bigint, decimals: number | null): string {
  if (decimals === null || decimals === 0) return quantity.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = quantity / scale;
  const fraction = (quantity % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
