// Narrow deterministic credential checks; ordinary private context is authorized for research.
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
  /\b(?:xox[baprs]-[\w-]{8,}|sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|AIza[\w-]{20,}|ya29\.[\w.-]{10,}|1\/\/[\w.-]{12,})/,
  /\b(?:api[_ -]?key|client[_ -]?secret|refresh[_ -]?token|access[_ -]?token|password)["']?\s*[=:]\s*["']?[^\s"'&]{6,}/i,
];
export function outboundQuerySafe(text, core = {}) {
  if (typeof text !== 'string' || text.length > 16000) return false;
  return credentialFree(text, core);
}
/** Generated private reading copies have a separate bound; query limits remain unchanged. */
export function outboundArtifactSafe(text, core = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) return false;
  const decoded = text.replace(/&(amp|lt|gt|quot|#39);/g,
    (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);
  return credentialFree(text, core) && credentialFree(decoded, core);
}
function credentialFree(text, core) {
  const variants = [text];
  for (let i = 0; i < 2; i++) {
    const value = variants.at(-1).replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
      try { return decodeURIComponent(encoded); }
      catch { return encoded.replace(/%([0-9a-f]{2})/gi, (_, byte) => String.fromCharCode(parseInt(byte, 16))); }
    });
    if (value === variants.at(-1)) break;
    variants.push(value);
  }
  const configuredSecrets = Object.entries(core).filter(([key, value]) =>
    /(?:key|secret|token|password)$/i.test(key) && typeof value === 'string' && value.length >= 8).map(([, value]) => value);
  return variants.every(value => !CREDENTIAL_PATTERNS.some(pattern => pattern.test(value))
    && !configuredSecrets.some(secret => value.includes(secret)));
}
