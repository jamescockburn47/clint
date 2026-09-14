/** Validated public DNS names only; a restriction is never silently broadened. */
export function domainRestrictions(query, includeDomains) {
  const valid = value => typeof value === 'string' && value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
  if (includeDomains !== undefined && (!Array.isArray(includeDomains) || includeDomains.length > 8)) {
    throw new Error('invalid_search_domains');
  }
  const explicit = includeDomains || [];
  const sites = [...String(query).matchAll(/(?:^|\s)site:([^\s]+)/gi)].map(match => match[1]);
  if ([...String(query).matchAll(/\bsite:/gi)].length !== sites.length) throw new Error('invalid_search_domains');
  if (sites.length > 8 || [...explicit, ...sites].some(value => !valid(value))) {
    throw new Error('invalid_search_domains');
  }
  const groups = [explicit, sites].filter(group => group.length).map(group => [...new Set(group.map(value => value.toLowerCase()))]);
  // Native search may use either group; local filtering always enforces both when both exist.
  return { groups, native: groups[0] || [] };
}

export function allowedSearchResult(result, restriction) {
  try {
    const url = new URL(result.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return restriction.groups.every(group => group.some(domain => host === domain || host.endsWith('.' + domain)));
  } catch { return false; }
}
