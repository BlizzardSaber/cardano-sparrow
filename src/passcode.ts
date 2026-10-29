// Local payment-password (passcode) guard. This is a privacy lock for the
// watch-only UI: a PBKDF2 verifier is stored locally, the app requires it on
// startup and before broadcasting. It does NOT encrypt any wallet data.

const STORAGE_KEY = "cardano-sparrow:passcode:v1";
const ITERATIONS = 600_000;
const MAX_ITERATIONS = 2_000_000;
const MIN_LENGTH = 6;
const MAX_LENGTH = 128;
const UNREADABLE_RECORD = "\u0000";

export type PasscodeRecord = { salt: string; hash: string; iterations: number };

function storage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function storedRecord(): string | null {
  try { return storage()?.getItem(STORAGE_KEY) ?? null; } catch { return UNREADABLE_RECORD; }
}

function requiredStorage(): Storage {
  const current = storage();
  if (!current) throw new Error("无法访问本地存储，支付密码未保存");
  return current;
}

export function passcodeRecord(): PasscodeRecord | null {
  try {
    const raw = storedRecord();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PasscodeRecord>;
    if (typeof parsed.salt !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(parsed.salt) ||
        typeof parsed.hash !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(parsed.hash) ||
        !Number.isInteger(parsed.iterations) || (parsed.iterations ?? 0) < 100_000 || (parsed.iterations ?? 0) > MAX_ITERATIONS) return null;
    return { salt: parsed.salt, hash: parsed.hash, iterations: parsed.iterations as number };
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, keyMaterial, 256);
  return toBase64(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = fromBase64(a);
  const right = fromBase64(b);
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function validatePassword(password: string) {
  if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) throw new Error(`支付密码长度必须在 ${MIN_LENGTH}–${MAX_LENGTH} 位之间`);
}

export function hasPasscode(): boolean {
  return storedRecord() !== null;
}

export async function verifyPasscode(password: string): Promise<boolean> {
  if (!hasPasscode()) return true;
  const record = passcodeRecord();
  if (!record) return false;
  try {
    const derived = await derive(password, fromBase64(record.salt), record.iterations);
    return constantTimeEqual(derived, record.hash);
  } catch {
    return false;
  }
}

export async function setupPasscode(next: string): Promise<void> {
  if (hasPasscode()) throw new Error("支付密码已设置，请使用修改流程");
  validatePassword(next);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(next, salt, ITERATIONS);
  requiredStorage().setItem(STORAGE_KEY, JSON.stringify({ salt: toBase64(salt), hash, iterations: ITERATIONS }));
}

export async function changePasscode(current: string, next: string): Promise<void> {
  if (!hasPasscode()) throw new Error("尚未设置支付密码");
  if (!(await verifyPasscode(current))) throw new Error("当前支付密码不正确");
  validatePassword(next);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(next, salt, ITERATIONS);
  requiredStorage().setItem(STORAGE_KEY, JSON.stringify({ salt: toBase64(salt), hash, iterations: ITERATIONS }));
}

export async function removePasscode(current: string): Promise<void> {
  if (!hasPasscode()) throw new Error("尚未设置支付密码");
  if (!(await verifyPasscode(current))) throw new Error("当前支付密码不正确");
  requiredStorage().removeItem(STORAGE_KEY);
}

// Escape hatch when the passcode is lost: wipes every locally stored wallet and
// the passcode itself. On-chain funds are untouched; wallets come back via
// descriptor backups.
export function resetLocalData(): void {
  storage()?.clear();
}
