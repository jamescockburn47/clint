import { z } from 'zod';
import { isAbsolute } from 'node:path';

const id = prefix => z.string().regex(new RegExp(`^${prefix}[A-Z0-9]{8,}$`));
const schema = z.object({
  SLACK_APP_TOKEN: z.string().regex(/^xapp-[A-Za-z0-9-]+$/),
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-[A-Za-z0-9-]+$/),
  SLACK_APP_ID: id('A'), SLACK_TEAM_ID: id('T'),
  SLACK_CHANNEL_ID: id('[CG]'), SLACK_OWNER_ID: id('[UW]'),
  SLACK_DATA_DIR: z.string().refine(isAbsolute),
  SLACK_CHANNEL_POLICY: z.string().default('{"mode":"colleague"}').transform((value, ctx) => {
    try { return JSON.parse(value); }
    catch { ctx.addIssue({ code: 'custom', message: 'invalid_policy_json' }); return z.NEVER; }
  }).pipe(z.object({
    mode: z.enum(['open', 'project', 'colleague']), label: z.string().optional(),
    blockedTopics: z.array(z.string().min(1).max(200)).default([]),
    allowedProjects: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).default([]),
    projectScopeMode: z.enum(['allow_list', 'single_project_only']).optional(),
    offTopicPolicy: z.enum(['allow', 'soft_redirect']).optional(),
  }).strict()),
  SLACK_MODEL_URL: z.string().url().default('http://127.0.0.1:11435').refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  }),
  SLACK_MODEL_ID: z.enum(['qwen3.8-27b', 'qwen3.8-flash-next']).default('qwen3.8-27b'),
  SLACK_PROACTIVE_ENABLED: z.enum(['true', 'false']).default('true'),
});

/** Dedicated configuration boundary: never inherit the legacy bot's credentials. */
export function loadSlackConfig(input = process.env) {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`slack_invalid_configuration:${
    result.error.issues.map(issue => issue.path.join('.')).join(',')}`);
  const v = result.data;
  return Object.freeze({ appToken: v.SLACK_APP_TOKEN, botToken: v.SLACK_BOT_TOKEN,
    appId: v.SLACK_APP_ID, teamId: v.SLACK_TEAM_ID, channelId: v.SLACK_CHANNEL_ID,
    ownerId: v.SLACK_OWNER_ID, dataDir: v.SLACK_DATA_DIR,
    modelUrl: v.SLACK_MODEL_URL, modelId: v.SLACK_MODEL_ID,
    proactiveEnabled: v.SLACK_PROACTIVE_ENABLED === 'true',
    policy: Object.freeze({ ...v.SLACK_CHANNEL_POLICY,
      blockedTopics: Object.freeze(v.SLACK_CHANNEL_POLICY.blockedTopics),
      allowedProjects: Object.freeze(v.SLACK_CHANNEL_POLICY.allowedProjects) }) });
}
