import { afterEach, describe, expect, test, vi } from "vitest";
import { changePasscode, hasPasscode, passcodeRecord, removePasscode, resetLocalData, setupPasscode, verifyPasscode } from "./passcode";

// Node has no localStorage; mirror the browser API over an in-memory map.
function installLocalStorage() {
  const map = new Map<string, string>();
  const mock = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => void map.clear(),
  };
  vi.stubGlobal("localStorage", mock);
  return mock;
}

describe("payment password", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("sets, verifies, and rejects wrong passwords with a hardened record", async () => {
    installLocalStorage();
    expect(hasPasscode()).toBe(false);
    await setupPasscode("correct horse battery");
    expect(hasPasscode()).toBe(true);
    const record = passcodeRecord()!;
    expect(record.iterations).toBeGreaterThanOrEqual(100_000);
    expect(record.salt).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(record.hash).toMatch(/^[A-Za-z0-9+/=]{43}=$/);
    expect(record.hash).not.toContain("correct");
    await expect(verifyPasscode("correct horse battery")).resolves.toBe(true);
    await expect(verifyPasscode("wrong horse battery")).resolves.toBe(false);
    await expect(verifyPasscode("")).resolves.toBe(false);
  });

  test("change requires the current password and re-salts the verifier", async () => {
    installLocalStorage();
    await setupPasscode("first-secret");
    const first = passcodeRecord()!;
    await expect(changePasscode("not-it", "second-secret")).rejects.toThrow(/当前支付密码不正确/);
    await changePasscode("first-secret", "second-secret");
    const second = passcodeRecord()!;
    expect(second.salt).not.toBe(first.salt);
    expect(second.hash).not.toBe(first.hash);
    await expect(verifyPasscode("second-secret")).resolves.toBe(true);
    await expect(verifyPasscode("first-secret")).resolves.toBe(false);
  });

  test("remove requires the current password and wipes the record", async () => {
    installLocalStorage();
    await setupPasscode("hunter22");
    await expect(removePasscode("nope1234")).rejects.toThrow(/当前支付密码不正确/);
    await removePasscode("hunter22");
    expect(hasPasscode()).toBe(false);
    await expect(verifyPasscode("anything")).resolves.toBe(true);
  });

  test("enforces minimum length and refuses double setup", async () => {
    installLocalStorage();
    await expect(setupPasscode("123")).rejects.toThrow(/支付密码长度/);
    await expect(setupPasscode("x".repeat(129))).rejects.toThrow(/支付密码长度/);
    await setupPasscode("longenough");
    await expect(setupPasscode("another-one")).rejects.toThrow(/修改流程/);
  });

  test("corrupted records fail closed instead of disabling the lock", async () => {
    const mock = installLocalStorage();
    mock.setItem("cardano-sparrow:passcode:v1", "not json");
    expect(hasPasscode()).toBe(true);
    await expect(verifyPasscode("anything")).resolves.toBe(false);
    await expect(setupPasscode("another-one")).rejects.toThrow(/修改流程/);
    mock.setItem("cardano-sparrow:passcode:v1", JSON.stringify({ salt: "aa", hash: "bb", iterations: 10 }));
    expect(hasPasscode()).toBe(true);
    await expect(verifyPasscode("anything")).resolves.toBe(false);
    mock.setItem("cardano-sparrow:passcode:v1", JSON.stringify({ salt: "A".repeat(22) + "==", hash: "A".repeat(43) + "=", iterations: 100_000_000 }));
    await expect(verifyPasscode("anything")).resolves.toBe(false);
  });

  test("storage read failure never bypasses the lock", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("storage blocked"); } });
    expect(hasPasscode()).toBe(true);
    await expect(verifyPasscode("anything")).resolves.toBe(false);
  });

  test("setting a passcode requires persistent storage", async () => {
    vi.stubGlobal("localStorage", undefined);
    await expect(setupPasscode("longenough")).rejects.toThrow(/本地存储/);
  });

  test("reset wipes all local data", async () => {
    const mock = installLocalStorage();
    await setupPasscode("reset-me");
    mock.setItem("cardano-sparrow:wallets:v1", "[]");
    resetLocalData();
    expect(hasPasscode()).toBe(false);
    expect(mock.getItem("cardano-sparrow:wallets:v1")).toBeNull();
  });
});
