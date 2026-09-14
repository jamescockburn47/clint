import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export function resolveProjectFile(root, input) {
  const realRoot = realpathSync(root);
  const candidate = realpathSync(resolve(realRoot, String(input || '.')));
  const rel = relative(realRoot, candidate);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Invalid path: outside project root.');
  }
  return candidate;
}
