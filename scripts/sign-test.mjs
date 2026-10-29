import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as C from "@emurgo/cardano-serialization-lib-nodejs";
import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const HARDENED = 0x80000000;
const inputPath = process.argv[2];
if (!inputPath) fail("用法：npm run sign:test -- /完整路径/transaction.json");

const pkg = JSON.parse(await readFile(inputPath, "utf8"));
if (pkg?.format !== "cardano-hd-multisig-tx" || ![1, 2, 3].includes(pkg.version) || pkg.network !== "preprod")
  fail("不是本项目生成的 Preprod unsigned transaction 签名包");

const tx = C.Transaction.from_hex(pkg.txCborHex);
const fixed = C.FixedTransaction.from_hex(pkg.txCborHex);
const calculatedHash = fixed.transaction_hash().to_hex();
if (calculatedHash !== pkg.txBodyHashHex) fail("签名包中的 transaction hash 与 CBOR 不一致");

const outputs = tx.body().outputs();
console.log("\n仅限 Preprod 测试。即将签名：");
console.log(`Transaction ID: ${calculatedHash}`);
console.log(`Fee:            ${ada(tx.body().fee().to_str())} ADA`);
for (let i = 0; i < outputs.len(); i++) {
  const output = outputs.get(i);
  console.log(`Output ${i}:       ${ada(output.amount().coin().to_str())} ADA`);
  console.log(`                ${output.address().to_bech32()}`);
  const multiAsset = output.amount().multiasset();
  if (multiAsset) {
    const policies = multiAsset.keys();
    for (let p = 0; p < policies.len(); p++) {
      const policy = policies.get(p);
      const assets = multiAsset.get(policy);
      const names = assets.keys();
      for (let n = 0; n < names.len(); n++) {
        const name = names.get(n);
        const raw = Buffer.from(name.name()).toString("hex");
        const printable = name.name().every((byte) => byte >= 0x20 && byte <= 0x7e);
        console.log(`                ${assets.get(name).to_str()} × ${printable ? Buffer.from(name.name()).toString("utf8") : `0x${raw}`} (policy ${Buffer.from(policy.to_bytes()).toString("hex").slice(0, 16)}…)`);
      }
    }
  }
}
if (pkg.certificates?.length) console.log(`Certificates:    ${pkg.certificates.map((c) => c.type + (c.poolId ? ` → ${c.poolId}` : "")).join(", ")}`);
if (pkg.withdrawalLovelace) console.log(`Withdrawal:      ${ada(pkg.withdrawalLovelace)} ADA`);
console.log(`Paths:           ${pkg.signingPaths.join(", ")}\n`);

const rl = createInterface({ input: stdin, output: stdout });
const confirmation = await rl.question("核对无误后输入 SIGN：");
rl.close();
if (confirmation !== "SIGN") fail("已取消，未签名");

let words = await hiddenQuestion("输入这个 Preprod 测试钱包的恢复词（输入不显示）：");
words = words.trim().toLowerCase().replace(/\s+/g, " ");
if (!validateMnemonic(words, wordlist)) fail("恢复词无效或校验和错误");

const entropy = mnemonicToEntropy(words, wordlist);
words = "";
const root = C.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array());
entropy.fill(0);
const account = root.derive(HARDENED + 1854).derive(HARDENED + 1815).derive(HARDENED);

const requiredHashes = new Set();
const scripts = tx.witness_set().native_scripts();
if (!scripts?.len()) fail("交易中没有 CIP-1854 native script witnesses");
for (let i = 0; i < scripts.len(); i++) {
  const required = scripts.get(i).get_required_signers();
  for (let j = 0; j < required.len(); j++) requiredHashes.add(required.get(j).to_hex());
}

let signed = 0;
for (const path of pkg.signingPaths) {
  const match = /^m\/1854'\/1815'\/0'\/(0|2)\/(\d+)$/.exec(path);
  if (!match || (match[1] === "2" && match[2] !== "0")) fail(`不支持的签名路径：${path}`);
  const key = account.derive(Number(match[1])).derive(Number(match[2]));
  const raw = key.to_raw_key();
  const keyHash = raw.to_public().hash().to_hex();
  if (!requiredHashes.has(keyHash)) fail(`该恢复词派生的 ${path} 不属于此多签脚本`);
  fixed.sign_and_add_vkey_signature(raw);
  signed++;
}

if (!signed) fail("签名包没有可签名路径");
const outputPath = join(dirname(inputPath), `${basename(inputPath, ".json")}.${calculatedHash.slice(0, 8)}.signed.txt`);
await writeFile(outputPath, `${fixed.to_hex()}\n`, { mode: 0o600 });
root.free();
console.log(`\n已签名 ${signed} 个派生路径。`);
console.log(`输出文件：${outputPath}`);
console.log("把文件中的整行 CBOR 粘贴到网页的一个 Signer 输入框。换另一个钱包重复一次。\n");

function ada(lovelace) {
  const value = BigInt(lovelace);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}

function fail(message) {
  console.error(`\n错误：${message}\n`);
  process.exit(1);
}

function hiddenQuestion(prompt) {
  if (!stdin.isTTY || !stdin.setRawMode) fail("必须在交互式终端中输入恢复词，禁止通过命令参数或管道传入");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (char) => {
      if (char === "\u0003") {
        cleanup();
        fail("已取消，未签名");
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(value);
      } else if (char === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}
