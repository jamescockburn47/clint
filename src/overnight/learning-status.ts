/** Owner-authenticated access to private review packets and durable worker state. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readLearningStatus(dir: string, date: string): Promise<{ worker: unknown; review: unknown }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid learning date');
  const read = async (path: string) => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  return { worker: await read(join(dir, `learning-run-${date}.json`)),
    review: await read(join(dir, 'proposals', `learning-${date}.json`)) };
}
