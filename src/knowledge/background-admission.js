import { readFile } from 'node:fs/promises';

/** One bounded CPU client uses the existing embedding server only while Flash is idle. */
export async function backgroundEmbeddingAllowed({ read = readFile, fetchFn = fetch } = {}) {
  try {
    const mem = await read('/proc/meminfo', 'utf8');
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(mem);
    if (!available || Number(available[1]) < 10 * 1024 * 1024) return false;
    const response = await fetchFn('http://127.0.0.1:11437/slots',
      { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const slots = await response.json();
    return Array.isArray(slots) && slots.length > 0 && slots.every(slot => slot.is_processing === false);
  } catch { return false; }
}
