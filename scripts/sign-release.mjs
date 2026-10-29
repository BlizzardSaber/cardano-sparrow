import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_FINGERPRINT = "7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7";
const [keyArgument, ...manifestArguments] = process.argv.slice(2);
if (!keyArgument || !manifestArguments.length)
  throw new Error("Usage: node scripts/sign-release.mjs /Volumes/OFFLINE/release-private.pem MANIFEST-*.sha256");

const keyPath = resolve(keyArgument);
const keyStat = await lstat(keyPath);
if (!keyStat.isFile() || keyStat.isSymbolicLink()) throw new Error("Release key must be a regular file, not a symlink");
if ((keyStat.mode & 0o077) !== 0) throw new Error("Release private key permissions must be 600");
const privateKey = createPrivateKey(await readFile(keyPath));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const fingerprint = createHash("sha256").update(publicDer).digest("hex");
if (fingerprint !== EXPECTED_FINGERPRINT) throw new Error(`Wrong release key fingerprint: ${fingerprint}`);

for (const argument of manifestArguments) {
  const manifestPath = resolve(argument);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error(`Manifest is not a regular file: ${manifestPath}`);
  const manifest = await readFile(manifestPath);
  if (!manifest.length || manifest[manifest.length - 1] !== 0x0a) throw new Error(`Manifest must be non-empty and newline-terminated: ${manifestPath}`);
  const signature = sign(null, manifest, privateKey);
  if (signature.length !== 64) throw new Error("Unexpected Ed25519 signature length");
  const signaturePath = manifestPath.replace(/\.sha256$/, ".sig");
  if (signaturePath === manifestPath) throw new Error(`Manifest must end in .sha256: ${manifestPath}`);
  await writeFile(signaturePath, signature, { mode: 0o644 });
  console.log(`Signed ${manifestPath}\n  -> ${signaturePath}`);
}
console.log(`Publisher key fingerprint: ${fingerprint}`);
