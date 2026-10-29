import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, SOURCE_DATE_EPOCH: "1704067200", TZ: "UTC", LC_ALL: "C" };
const build = () => execFileSync("npm", ["run", "build"], { cwd: root, env, stdio: "inherit" });
build();
const first = await digestTree(resolve(root, "dist"));
build();
const second = await digestTree(resolve(root, "dist"));
if (first !== second) throw new Error(`Build is not reproducible:\n${first}\n${second}`);
console.log(`Reproducible web payload: ${first}`);

async function digestTree(dir) {
  const hash = createHash("sha256");
  for (const file of await files(dir)) {
    hash.update(relative(dir, file)); hash.update("\0"); hash.update(await readFile(file)); hash.update("\0");
  }
  return hash.digest("hex");
}
async function files(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) output.push(...await files(path)); else if (entry.isFile()) output.push(path);
  }
  return output.sort();
}
