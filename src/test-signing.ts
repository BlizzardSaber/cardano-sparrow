import * as C from "@emurgo/cardano-serialization-lib-browser";
import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { validateUnsignedPackage } from "./cardano";

const HARDENED = 0x80000000;

// Preprod-only helper. The UI loads it dynamically for test-wallet signing.
export function signWithTestMnemonic(pkgValue: unknown, phrase: string) {
  const pkg = validateUnsignedPackage(pkgValue);
  if (pkg.network !== "preprod") throw new Error("主网禁用助记词软件签名，请使用硬件钱包或离线签名器");
  const words = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(words, wordlist)) throw new Error("英文 BIP39 助记词无效或校验和错误");

  const entropy = mnemonicToEntropy(words, wordlist);
  const root = C.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array());
  entropy.fill(0);
  try {
    const account = root.derive(HARDENED + 1854).derive(HARDENED + 1815).derive(HARDENED);
    const parsed = C.Transaction.from_hex(pkg.txCborHex);
    const fixed = C.FixedTransaction.from_hex(pkg.txCborHex);
    const scripts = parsed.witness_set().native_scripts();
    if (!scripts?.len()) throw new Error("交易中没有 native script witnesses");
    const requiredHashes = new Set<string>();
    for (let i = 0; i < scripts.len(); i++) {
      const required = scripts.get(i).get_required_signers();
      for (let j = 0; j < required.len(); j++) requiredHashes.add(required.get(j).to_hex());
    }
    const signerHashes: string[] = [];
    for (const path of pkg.signingPaths) {
      const match = /^m\/1854'\/1815'\/0'\/(0|2)\/(\d+)$/.exec(path);
      if (!match || (match[1] === "2" && match[2] !== "0")) throw new Error("签名包不是受支持的 CIP-1854 M-of-N 交易");
      const raw = account.derive(Number(match[1])).derive(Number(match[2])).to_raw_key();
      const keyHash = raw.to_public().hash().to_hex();
      if (!requiredHashes.has(keyHash)) throw new Error(`这个钱包的 ${path} 公钥不属于该多签账户`);
      fixed.sign_and_add_vkey_signature(raw);
      signerHashes.push(keyHash);
    }
    return { signedTxHex: fixed.to_hex(), signerHashes };
  } finally {
    root.free();
  }
}
