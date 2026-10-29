import { bech32 } from "bech32";
import { blake2b } from "./blake2b";

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(value) || value.length % 2) throw new Error("无效的十六进制字符串");
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// CIP-14: bech32("asset", blake2b-160(policyId || assetName)).
// Computed locally instead of trusting indexer-supplied fingerprints.
export function assetFingerprint(policyId: string, assetNameHex: string): string {
  if (!/^[0-9a-f]{56}$/i.test(policyId)) throw new Error("Policy ID 必须是 28 字节十六进制");
  if (!/^[0-9a-f]{0,64}$/i.test(assetNameHex)) throw new Error("资产名称必须是 0–32 字节十六进制");
  const digest = blake2b(hexToBytes(policyId.toLowerCase() + assetNameHex.toLowerCase()), 20);
  return bech32.encode("asset", bech32.toWords(digest), 200);
}

// Display name candidates decoded from the raw asset name bytes: printable ASCII
// is shown directly, otherwise the hex form stays canonical.
export function assetNameText(assetNameHex: string): string {
  if (!assetNameHex) return "";
  const bytes = hexToBytes(assetNameHex);
  const printable = bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
  return printable ? new TextDecoder().decode(bytes) : assetNameHex;
}

export function shortFingerprint(fingerprint: string, keep = 10): string {
  return fingerprint.length <= keep * 2 + 1 ? fingerprint : `${fingerprint.slice(0, keep)}…${fingerprint.slice(-keep)}`;
}
