import { packager } from "@electron/packager";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = resolve(root, "work/desktop-staging");
// Code-sign outside Documents/iCloud/File Provider locations. Those providers may
// add Finder metadata while codesign is running, which invalidates the bundle.
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const out = resolve(`/private/tmp/cardano-sparrow-desktop-${pkg.version}`);
await rm(staging, { recursive: true, force: true });
await rm(out, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(resolve(root, "dist"), resolve(staging, "dist"), { recursive: true });
await mkdir(resolve(staging, "desktop"), { recursive: true });
await cp(resolve(root, "desktop/main.mjs"), resolve(staging, "desktop/main.mjs"));
await cp(resolve(root, "desktop/preload.cjs"), resolve(staging, "desktop/preload.cjs"));
await cp(resolve(root, "desktop/origin.mjs"), resolve(staging, "desktop/origin.mjs"));
await cp(resolve(root, "desktop/koios-retry.mjs"), resolve(staging, "desktop/koios-retry.mjs"));
await cp(resolve(root, "desktop/blockfrost-proxy.mjs"), resolve(staging, "desktop/blockfrost-proxy.mjs"));
await writeFile(resolve(staging, "package.json"), `${JSON.stringify({ name: pkg.name, productName: "Cardano Sparrow", version: pkg.version, type: "module", main: "desktop/main.mjs" }, null, 2)}\n`);

const [appPath] = await packager({
  dir: staging, out, overwrite: true, asar: true,
  name: "Cardano Sparrow", appBundleId: "io.cardanosparrow.wallet",
  appVersion: pkg.version, buildVersion: pkg.version,
  platform: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64",
  electronVersion: pkg.devDependencies.electron, icon: resolve(root, "desktop/assets/cardano"),
  usageDescription: { Camera: "Scan Cardano receiving address QR codes when you choose Scan QR. Camera video stays on this Mac." },
});
const appBundle = resolve(appPath, "Cardano Sparrow.app");
// Packager 20 first probes Apple's newer layered icon format. Ensure the
// conventional ICNS is installed even when that optional format is absent.
await cp(resolve(root, "desktop/assets/cardano.icns"), resolve(appBundle, "Contents/Resources/electron.icns"));
execFileSync("xattr", ["-cr", appBundle], { stdio: "inherit" });
execFileSync("codesign", ["--force", "--deep", "--sign", "-", appBundle], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle], { stdio: "inherit" });
console.log(appBundle);
