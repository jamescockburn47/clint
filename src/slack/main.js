import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { loadSlackConfig } from './config.js';
import { acceptMention } from './policy.js';
import { authorizeChannel } from './channel-access.js';
import { SlackStore } from './store.js';
import { SlackWorker, errorCode } from './worker.js';
import { makeSlackGenerator, SLACK_PROMPT_VERSION } from './model.js';
import coreConfig from '../config.js';
import { validateSlackCoreConfig } from './core-config.js';
import { checkEvoHealth } from '../memory.js';
import { ProactiveWorker } from './proactive.js';
import { channelConfigs, authorizeActor } from './workspace-channels.js';
import { checkStartupChannels, PublicChannelHealth } from './channel-health.js';
import { readSlackHistory } from './history.js';

// Status words plus an optional short error code. Never source text, tokens or SDK bodies.
const report = (status, detail) => console.log(JSON.stringify(
  detail ? { component: 'clint_slack', status, detail } : { component: 'clint_slack', status }));
// Never print SDK messages/arguments: they can include tokens, socket URLs or event bodies.
const sdkLogger = { debug() {}, info() {}, warn() { report('sdk_warning'); },
  error() { report('sdk_error'); }, setLevel() {}, getLevel() { return 'error'; }, setName() {} };
let shutdown = code => process.exit(code);

async function main() {
  let config = loadSlackConfig();
  validateSlackCoreConfig(coreConfig, config);
  await checkEvoHealth({ recover: false });
  const web = new WebClient(config.botToken, { logger: sdkLogger, retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true, timeout: 15000 });
  const auth = await web.auth.test();
  if (!auth.ok || auth.team_id !== config.teamId || !auth.bot_id || !auth.user_id ||
      auth.user_id === config.ownerId) throw new Error('slack_wrong_installation');
  config = Object.freeze({ ...config, botUserId: auth.user_id });
  const channels = channelConfigs(config);
  await checkStartupChannels(web, channels, report);
  const publicHealth = new PublicChannelHealth({ web, channels, report });
  const resolveConfig = event => channels.find(channel => channel.channelId === event.channel);
  const generators = new Map(channels.map(channel => [channel.channelId, makeSlackGenerator(channel, undefined, undefined,
    event => !channel.workspaceShared && event.owner === channel.ownerId && authorizeChannel(web, channel))]));
  const store = new SlackStore(config.dataDir);
  store.recover();
  const worker = new SlackWorker({ store, config, web, resolveConfig,
    readHistory: (channel, event) => readSlackHistory(web, channel, event),
    generate: (event, ...args) => generators.get(event.channel)(event, ...args), report });
  const proactive = new ProactiveWorker({ config, web, inbox: store, interactive: worker, report });
  const socket = new SocketModeClient({ appToken: config.appToken, logger: sdkLogger,
    clientOptions: { logger: sdkLogger, retryConfig: { retries: 2 }, timeout: 15000 } });
  let stopping = false;
  const drain = () => worker.drain().catch(err => { report('worker_storage_failure', errorCode(err)); shutdown(1); });
  socket.on('slack_event', async ({ body, ack }) => {
    try {
      if (stopping) return;
      const channel = channels.find(candidate => candidate.channelId === body?.event?.channel);
      let event = channel ? acceptMention(body, channel, auth.user_id) : null;
      if (event && !await authorizeActor(web, channel, event)) {
        report(channel.workspaceShared ? 'public_actor_denied' : 'private_actor_denied'); event = null;
      }
      if (event && channel.workspaceShared && !await authorizeChannel(web, channel)) {
        report('public_channel_denied'); event = null; void publicHealth.check();
      }
      const outcome = event ? store.enqueue(event, Date.now()) : 'rejected';
      // Durable persistence precedes ACK. Unauthorized events are discarded without storing text.
      await ack();
      report(outcome);
      if (outcome === 'queued') { proactive.interrupt(); void drain(); }
    } catch (err) { report('inbox_or_ack_failed', errorCode(err)); }
  });
  socket.on('error', () => report('socket_error'));
  socket.on('connected', () => report('socket_connected'));
  const timer = setInterval(() => void drain(), 15000);
  const healthTimer = setInterval(() => void checkEvoHealth({ recover: false }), 60000);
  const proactiveTimer = setInterval(() => void proactive.tick(), 60000);
  const publicHealthTimer = setInterval(() => void publicHealth.check(), 60000);
  const inboxTimer = setInterval(() => {
    const stuck = store.counts().filter(row => ['failed', 'uncertain', 'blocked'].includes(row.state));
    if (stuck.length) report('inbox_needs_attention', stuck.map(row => `${row.state}=${row.count}`).join(','));
  }, 3600000);
  shutdown = async code => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(healthTimer);
    clearInterval(proactiveTimer);
    clearInterval(publicHealthTimer);
    clearInterval(inboxTimer);
    try { await socket.disconnect(); await proactive.stop(); await worker.stop(); store.close(); }
    catch (err) { report('shutdown_failed', errorCode(err)); code = 1; }
    process.exit(code);
  };
  process.once('SIGTERM', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));
  await socket.start();
  report(`ready:${SLACK_PROMPT_VERSION}`);
  void publicHealth.check();
  void drain();
}
// A stray rejection must stop the process cleanly rather than leave a half-sent row behind.
process.on('unhandledRejection', err => { report('unhandled_rejection', errorCode(err)); void shutdown(1); });
main().catch(err => { report('startup_failed', errorCode(err)); process.exit(1); });
