import type { checkImprove as checkImproveFn } from './improve-task.js';

type CheckImprove = typeof checkImproveFn;

interface ForgeNowLogger {
  error(fields: { err: string }, message: string): void;
}

export interface TriggerForgeNowOptions {
  now?: Date;
  checkImprove: CheckImprove;
  logger: ForgeNowLogger;
}

export interface ForgeNowResponse {
  status: 202;
  body: {
    ok: true;
    message: string;
    todayStr: string;
  };
}

export function londonDateString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('failed to format London date');
  }
  return `${year}-${month}-${day}`;
}

export async function triggerForgeNow({
  now = new Date(),
  checkImprove,
  logger,
}: TriggerForgeNowOptions): Promise<ForgeNowResponse> {
  const todayStr = londonDateString(now);
  checkImprove(todayStr, 22, 0, undefined, { emergencyMode: true }).catch((err) => {
    logger.error({ err: (err as Error).message }, 'forge-now: emergency improve failed');
  });
  return {
    status: 202,
    body: { ok: true, message: 'emergency IMPROVE started', todayStr },
  };
}
