export function blockfrostTarget(path: string, method: string): string;
export function proxyBlockfrost(path: string, method: string, key: string | null, contentType: string | null, body: Uint8Array | null, fetchRequest: (url: string, init: RequestInit) => Promise<Response>): Promise<Response>;
