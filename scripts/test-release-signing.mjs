import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const EXPECTED_FINGERPRINT = "7579b1ba72cb31cd893040deba3301e03de7c7e27bf2df763ab75c8bfece7ea7";
const MESSAGE = Buffer.from("cardano-sparrow-release-verifier-test-v1\n");
const SIGNATURE = Buffer.from("e3569b1c99a7d929d52c8faecdb25c66c7d3e7c3accfb4c6cb629bdcb28811ded40ac2eca24e490d41488d5be9d41e191b5a26acfd2b521bff9817c0a0796d00", "hex");
const key = createPublicKey(await readFile(new URL("../desktop/RELEASE-PUBLIC-KEY.pem", import.meta.url)));
const fingerprint = createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
if (fingerprint !== EXPECTED_FINGERPRINT) throw new Error("Pinned publisher-key fingerprint changed");
if (!verify(null, MESSAGE, key, SIGNATURE)) throw new Error("Known publisher signature was rejected");
if (verify(null, Buffer.concat([MESSAGE, Buffer.from("tampered")]), key, SIGNATURE)) throw new Error("Tampered payload was accepted");
const corrupted = Buffer.from(SIGNATURE); corrupted[0] ^= 1;
if (verify(null, MESSAGE, key, corrupted)) throw new Error("Corrupted publisher signature was accepted");
console.log("Release-signing checks passed.");
