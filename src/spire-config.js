/** Called only by the central configuration boundary; no model-controlled destinations. */
export function loadSpireConfig(input) {
  const url = input.CLINT_SPIRE_MCP_URL || '';
  const key = input.CLINT_SPIRE_AGENT_KEY || '';
  if (!!url !== !!key) throw Error('spire_configuration_pair_required');
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw Error('spire_configuration_url'); }
    if (!['https:', 'http:'].includes(parsed.protocol) ||
        (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1') ||
        parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/mcp' ||
        typeof key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(key)) throw Error('spire_configuration_invalid');
  }
  // Include Slack credentials and configured secrets without sending them to the model or logs.
  const guard = Object.fromEntries(Object.entries(input).filter(([name, value]) =>
    /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name) && typeof value === 'string' && value.length >= 8));
  return Object.freeze({ enabled: !!url, url, key, guard: Object.freeze(guard) });
}
