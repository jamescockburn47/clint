import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { loadSlackConfig } from './config.js';
import { acceptMention, allowedChannel } from './policy.js';
import { SlackStore } from './store.js';
import { SlackWorker } from './worker.js';
import { makeSlackGenerator, SLACK_PROMPT_VERSION } from './model.js';
import coreConfig from '../config.js';
import { validateSlackCoreConfig } from './core-config.js';
import { checkEvoHealth } from '../memory.js';

const report = status => console.log(JSON.stringify({ component: 'clint_slack', status }));
// Never print SDK messages/arguments: they can include tokens, socket URLs or event bodies.
const sdkLogger = { debug() {}, info() {}, warn() { report('sdk_warning'); },
  error() { report('sdk_error'); }, setLevel() {}, getLevel() { return 'error'; }, setName() {} };

async function main() {
  const config = loadSlackConfig();
  validateSlackCoreConfig(coreConfig, config);
  await checkEvoHealth({ recover: false });
  const web = new WebClient(config.botToken, { logger: sdkLogger, retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true, timeout: 15000 });
  const auth = await web.auth.test();
  if (!auth.ok || auth.team_id !== config.teamId || !auth.bot_id || !auth.user_id ||
      auth.user_id === config.ownerId) throw new Error('slack_wrong_installation');
  if (!allowedChannel(await web.conversations.info({ channel: config.channelId }), config)) {
    throw new Error('slack_channel_not_ready');
  }
  const store = new SlackStore(config.dataDir);
  store.recover();
  const worker = new SlackWorker({ store, config, web, generate: makeSlackGenerator(config), report });
  const socket = new SocketModeClient({ appToken: config.appToken, logger: sdkLogger,
    clientOptions: { logger: sdkLogger, retryConfig: { retries: 2 }, timeout: 15000 } });
  let stopping = false;
  const drain = () => worker.drain().catch(() => { report('worker_storage_failure'); shutdown(1); });
  socket.on('slack_event', async ({ body, ack }) => {
    try {
      if (stopping) return;
      const event = acceptMention(body, config, auth.user_id);
      const outcome = event ? store.enqueue(event, Date.now()) : 'rejected';
      // Durable persistence precedes ACK. Unauthorized events are discarded without storing text.
      await ack();
      report(outcome);
      if (outcome === 'queued') void drain();
    } catch { report('inbox_or_ack_failed'); }
  });
  socket.on('error', () => report('socket_error'));
  socket.on('connected', () => report('socket_connected'));
  const timer = setInterval(() => void drain(), 15000);
  const healthTimer = setInterval(() => void checkEvoHealth({ recover: false }), 60000);
  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(healthTimer);
    try { await socket.disconnect(); await worker.stop(); store.close(); }
    catch { report('shutdown_failed'); code = 1; }
    process.exit(code);
  }
  process.once('SIGTERM', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));
  await socket.start();
  report(`ready:${SLACK_PROMPT_VERSION}`);
  void drain();
}
main().catch(() => { report('startup_failed'); process.exit(1); });
