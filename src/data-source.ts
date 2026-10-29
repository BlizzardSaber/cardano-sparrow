import type { CardanoNetwork } from "./network";

export type DataSource = "koios" | "blockfrost";
export type SourceMode = "auto" | DataSource;
export type SourceSettings = { mode: SourceMode; mainnet: string; preprod: string; verify: boolean };
const STORAGE = "cardano-sparrow:data-sources:v1";
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const LAST_SOURCE = "cardano-sparrow:last-source:v1";
let revision = 0;
function loadPreferred(): Partial<Record<CardanoNetwork, DataSource>> {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_SOURCE) ?? "{}");
    return Object.fromEntries((["mainnet", "preprod"] as const).filter((n) => value[n] === "blockfrost").map((n) => [n, "blockfrost"]));
  } catch { return {}; }
}
const preferred = loadPreferred();
export function sourceSettings(): SourceSettings {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE) ?? "{}");
    return { mode: v.mode === "koios" || v.mode === "blockfrost" ? v.mode : "auto",
      mainnet: KEY.test(v.mainnet ?? "") ? v.mainnet : "", preprod: KEY.test(v.preprod ?? "") ? v.preprod : "", verify: v.verify !== false };
  } catch { return { mode: "auto", mainnet: "", preprod: "", verify: true }; }
}
export function saveSourceSettings(v: SourceSettings) {
  if (!["auto", "koios", "blockfrost"].includes(v.mode) || [v.mainnet, v.preprod].some((key) => key !== "" && !KEY.test(key)))
    throw new Error("Blockfrost Project ID 格式无效");
  localStorage.setItem(STORAGE, JSON.stringify(v));
  revision++;
  delete preferred.mainnet; delete preferred.preprod;
  try { localStorage.setItem(LAST_SOURCE, "{}"); } catch { /* Saved settings remain authoritative. */ }
}
export function activeSource(network: CardanoNetwork): DataSource {
  const s = sourceSettings();
  return s.mode !== "auto" ? s.mode : s[network] ? preferred[network] ?? "koios" : "koios";
}
export class SourceHttpError extends Error {
  constructor(public source: DataSource, public status: number) {
    super(source === "koios" && status === 429
      ? "Koios 请求过于频繁，请稍后重试或配置免费的 API Token / Blockfrost 备用源"
      : `${source === "koios" ? "Koios" : "Blockfrost"} 请求失败 (${status})${source === "blockfrost" && status === 403 ? "：请检查当前网络的 Project ID" : ""}`);
  }
}
export async function withSource<T>(network: CardanoNetwork, run: (source: DataSource) => Promise<T>): Promise<T> {
  const runRevision = revision;
  const attempt = async (source: DataSource) => {
    try { return await run(source); } catch (error) {
      if (source === "blockfrost" && error instanceof Error && !(error instanceof SourceHttpError))
        error.message = error.message.replace(/^Koios/, "Blockfrost");
      throw error;
    }
  };
  const first = activeSource(network);
  try { return await attempt(first); } catch (error) {
    if (sourceSettings().mode !== "auto" || !sourceSettings()[network] ||
        !(error instanceof SourceHttpError && (error.status === 0 || error.status === 429 || error.status === 413 || error.status >= 500))) throw error;
    const second = first === "koios" ? "blockfrost" : "koios";
    const result = await attempt(second);
    if (revision === runRevision) {
      preferred[network] = second;
      try { localStorage.setItem(LAST_SOURCE, JSON.stringify(preferred)); } catch { /* Memory preference still applies. */ }
    }
    return result;
  }
}
