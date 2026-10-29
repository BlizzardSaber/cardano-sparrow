export function isAppOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "cardano-sparrow:" && url.hostname === "app" &&
      !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}
