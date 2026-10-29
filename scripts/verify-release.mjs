import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

const EXPECTED_KEY_FINGERPRINT = "7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7";

const [manifestArg, signatureArg, publicKeyArg] = process.argv.slice(2);
if (!manifestArg || !signatureArg || !publicKeyArg) {
  throw new Error("Usage: npm run release:verify -- MANIFEST.sha256 MANIFEST.sig RELEASE-PUBLIC.pem");
}
const manifestPath = resolve(manifestArg);
const releaseDir = dirname(manifestPath);
const manifestInfo = await lstat(manifestPath);
if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("Manifest must be a regular non-symlink file");

const signaturePath = resolve(signatureArg);
const signatureInfo = await lstat(signaturePath);
if (!signatureInfo.isFile() || signatureInfo.isSymbolicLink()) throw new Error("Signature must be a regular non-symlink file");

const publicKeyPath = resolve(publicKeyArg);
const publicKeyInfo = await lstat(publicKeyPath);
if (!publicKeyInfo.isFile() || publicKeyInfo.isSymbolicLink()) throw new Error("Public key must be a regular non-symlink file");

const manifest = await readFile(manifestPath);
if (manifest.length === 0 || manifest.at(-1) !== 0x0a) throw new Error("Manifest must be non-empty and newline-terminated");
const signature = await readFile(signaturePath);
if (signature.length !== 64) throw new Error("Ed25519 signature must be exactly 64 bytes");
const publicKey = createPublicKey(await readFile(publicKeyPath));
if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Publisher key is not Ed25519");
const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
if (fingerprint !== EXPECTED_KEY_FINGERPRINT) throw new Error(`Unexpected publisher key fingerprint: ${fingerprint}`);
if (!verify(null, manifest, publicKey, signature)) throw new Error("Release signature is invalid");
const seen = new Set();
for (const line of manifest.toString("utf8").slice(0, -1).split("\n")) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  const name = match?.[2] ?? "";
  if (!match || isAbsolute(name) || name.includes("\\") || normalize(name) !== name ||
      name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid or unsafe manifest line: ${line}`);
  }
  if (seen.has(name)) throw new Error(`Duplicate manifest entry: ${name}`);
  seen.add(name);
  const file = resolve(releaseDir, name);
  if (!file.startsWith(`${releaseDir}${sep}`)) throw new Error(`Unsafe path: ${name}`);
  const fileInfo = await lstat(file);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`Not a regular non-symlink file: ${name}`);
  const hash = createHash("sha256");
  await new Promise((done, fail) => createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", done).on("error", fail));
  if (hash.digest("hex") !== match[1]) throw new Error(`Hash mismatch: ${name}`);
}
console.log(`Release signature and all file hashes are valid.\nPublisher fingerprint: ${fingerprint}`);
