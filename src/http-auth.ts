/** Fail-closed bearer/query authentication shared by every privileged HTTP route. */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function isAuthorized(req: Pick<IncomingMessage, 'url' | 'headers'>, token: string): boolean {
  if (!token || token.trim().length === 0) return false;
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
  return [bearer, query].some(value => {
    if (value === null) return false;
    const expected = Buffer.from(token), supplied = Buffer.from(value);
    return supplied.length === expected.length && timingSafeEqual(expected, supplied);
  });
}
