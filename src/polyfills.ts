// @ledgerhq/hw-transport-webhid assembles HID frames with the Node Buffer
// global, which does not exist in browsers or the sandboxed desktop renderer.
// Load the standard polyfill before any Ledger module is imported.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as { Buffer: typeof Buffer }).Buffer = Buffer;
}

export {};
