import coreConfig from '../config.js';
import { currentConversation } from '../conversation-context.js';
import { permitsTool } from '../conversation-tools.js';
import { filterResponse, getBlockedResponse } from '../output-filter.js';
import { outboundQuerySafe } from '../outbound-query.js';
import { systemStatus } from '../runtime-status.js';

const GROUPS = [
  [['web_search', 'web_fetch'], 'Research the web and read public sources.'],
  [['calendar_list_calendars', 'calendar_read_events'], 'Read Google Calendar events.'],
  [['drive_search', 'drive_read'], 'Search Google Drive and read supported documents.'],
  [['knowledge_status', 'knowledge_search', 'knowledge_read'], 'Search saved conversation archives and open matching records.'],
  [['repository_status'], 'Inspect registered repository status.'],
  [['system_status'], 'Check my current model and hardware.'],
];
const safeLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
  /^[\w .+():/\\-]+$/.test(value) ? value : 'not observed';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'not observed';
const gib = value => Number.isSafeInteger(value) && value >= 0 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : 'not observed';
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) ? value : 'time unavailable';
const UNAVAILABLE = 'I could not read the current runtime. No earlier snapshot has been reused.';

export function renderHelp(names) {
  const available = new Set(names);
  const lines = GROUPS.filter(([required]) => required.every(name => available.has(name))).map(([, text]) => `• ${text}`);
  const described = new Set(GROUPS.filter(([required]) => required.every(name => available.has(name))).flatMap(([required]) => required));
  // Keep additions discoverable without inventing their behavior from a new tool name.
  const other = [...available].filter(name => !described.has(name) && /^[a-z][a-z0-9_]{0,79}$/.test(name));
  if (other.length) lines.push(`Other available tools: ${other.join(', ')}.`);
  return ['I can help you think through problems, draft text and work with these tools:', ...lines,
    'Connections and source access are checked when used; this list is not a completed read.',
    'Start a request with “think:”, “clint think:” or “use thinking mode:” for deeper reasoning on that request. Ordinary requests use fast mode; overnight research uses thinking automatically.',
    'Ask naturally, or send “clint status” for a fresh model and hardware snapshot.'].join('\n');
}

export function renderStatus(snapshot) {
  if (snapshot?.state !== 'runtime_snapshot') return UNAVAILABLE;
  const model = snapshot.model || {}, hardware = snapshot.hardware || {}, deployment = snapshot.deployment || {};
  const modelObserved = model.state === 'observed';
  const lines = [`Runtime snapshot: ${timestamp(snapshot.observedAt)}`,
    `Configured model: ${safeLabel(model.configuredModel)}.`,
    `Server observation: ${modelObserved ? safeLabel(model.reportedModel) : 'unavailable; the configured name does not establish a running model'}.`,
    `Model observation time: ${timestamp(model.observedAt)}.`,
    `Context per slot: ${modelObserved ? integer(model.contextPerSlot) : 'not observed'} tokens; slots: ${modelObserved ? integer(model.slots) : 'not observed'}.`,
    `CPU: ${safeLabel(hardware.cpu)}; logical CPUs: ${integer(hardware.logicalCpus)}.`,
    `System: ${safeLabel(hardware.platform)} ${safeLabel(hardware.architecture)}; hardware observation: ${timestamp(hardware.observedAt)}.`,
    `Linux-managed RAM: ${gib(hardware.linuxManagedBytes)}; available: ${gib(hardware.linuxAvailableBytes)}.`];
  const gpu = Array.isArray(hardware.gpu) ? hardware.gpu.slice(0, 8) : [];
  if (!gpu.length) lines.push('GPU allocation: not observed.');
  for (const card of gpu) lines.push(`GPU ${safeLabel(card.device)}: ${gib(card.usedBytes)} used of ${gib(card.totalBytes)} allocated.`);
  lines.push('Linux-managed RAM excludes reserved GPU memory. GTT shares host RAM and is not an extra allocation.',
    `Installed physical RAM: ${gib(hardware.installedPhysicalBytes)}.`,
    `Release: ${typeof deployment.release === 'string' && /^[a-f0-9]{16}$/.test(deployment.release) ? deployment.release : 'not observed'}.`,
    'This is a point-in-time observation, not a model quality or weight-checksum check.');
  return lines.join('\n');
}

/** Explicit current-message commands only; no intent classifier, history or model call. */
export async function quickCommand(text, config, { status = systemStatus, getTools = () => [], core = coreConfig } = {}) {
  const scope = currentConversation();
  if (!scope || scope.transport !== 'slack' || (!scope.isOwner && !scope.policy.workspaceShared) || !scope.localOnly || !scope.readOnly ||
      scope.webOnly || scope.audience !== 'group' || !scope.privateContext || scope.policy.mode !== 'open') return null;
  const match = typeof text === 'string' && /^clint (help|status)$/i.exec(text.trim());
  if (!match) return null;
  const inputFilter = filterResponse(text, scope.conversationId);
  if (!inputFilter.safe) return getBlockedResponse(inputFilter.reason);
  let answer;
  if (match[1].toLowerCase() === 'help') {
    answer = renderHelp(getTools().filter(tool => permitsTool(tool.name, undefined, scope, core)).map(tool => tool.name));
  } else {
    if (!permitsTool('system_status', {}, scope, core)) return null;
    try {
      answer = renderStatus(JSON.parse(await status({ scope,
        core: { ...core, evoLlmUrl: config.modelUrl, evoChatModel: config.modelId } })));
    } catch { answer = UNAVAILABLE; } // Explicit failed observation; never echo source errors or use old state.
  }
  const outputFilter = filterResponse(answer, scope.conversationId);
  if (!outputFilter.safe) return getBlockedResponse(outputFilter.reason);
  return outboundQuerySafe(answer, core) ? answer : "I can't share that information.";
}
