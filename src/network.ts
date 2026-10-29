export type CardanoNetwork = "mainnet" | "preprod";

export const NETWORKS = {
  mainnet: {
    label: "Mainnet",
    networkId: 1,
    protocolMagic: 764824073,
    apiPrefix: "/koios-mainnet/api/v1",
    explorer: "https://cardanoscan.io",
  },
  preprod: {
    label: "Preprod",
    networkId: 0,
    protocolMagic: 1,
    apiPrefix: "/koios-preprod/api/v1",
    explorer: "https://preprod.cardanoscan.io",
  },
} as const satisfies Record<CardanoNetwork, {
  label: string;
  networkId: number;
  protocolMagic: number;
  apiPrefix: string;
  explorer: string;
}>;

export function networkConfig(network: CardanoNetwork) {
  return NETWORKS[network];
}
