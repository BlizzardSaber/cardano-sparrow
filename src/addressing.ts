import type { DerivedAddress } from "./types";

export function nextReceiveAddress(addresses: DerivedAddress[], usedIndexes: Set<number>) {
  const highestUsed = usedIndexes.size ? Math.max(...usedIndexes) : -1;
  return addresses.find((address) => address.index === highestUsed + 1);
}

export function requiredDiscoverySize(gapLimit: number, usedIndexes: Set<number>) {
  const highestUsed = usedIndexes.size ? Math.max(...usedIndexes) : -1;
  return highestUsed + 1 + gapLimit;
}
