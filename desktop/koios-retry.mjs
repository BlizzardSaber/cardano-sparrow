const RETRY_DELAYS = [0, 750, 1500, 3000, 6000];

export async function fetchWithRetry(url, init, fetchRequest, drain, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const attempts = new URL(url).pathname.endsWith("/submittx") ? 1 : RETRY_DELAYS.length;
  let previousResponse;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await wait(retryDelay(previousResponse, RETRY_DELAYS[attempt]));
    try {
      const result = await fetchRequest(url, init);
      if ((result.status !== 429 && result.status < 500) || attempt === attempts - 1) return result;
      previousResponse = result;
      await drain(result);
    } catch (error) {
      previousResponse = undefined;
      if (attempt === attempts - 1) throw error;
    }
  }
}

function retryDelay(response, fallback) {
  const raw = response?.headers.get("retry-after");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, fallback), 15_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), fallback), 15_000) : fallback;
}
