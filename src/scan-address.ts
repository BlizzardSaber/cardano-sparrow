import * as C from "@emurgo/cardano-serialization-lib-browser";
import { networkConfig, type CardanoNetwork } from "./network";

export function parseScannedAddress(value: string, network: CardanoNetwork): string {
  const address = value.trim();
  if (address.length > 512 || !/^addr(_test)?1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(address))
    throw new Error("scan.invalid");
  try {
    const parsed = C.Address.from_bech32(address);
    if (!parsed.payment_cred() || parsed.network_id() !== networkConfig(network).networkId || parsed.to_bech32() !== address)
      throw new Error("scan.invalid");
    return address;
  } catch {
    throw new Error("scan.invalid");
  }
}
