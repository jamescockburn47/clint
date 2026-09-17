import { ANSWER_TOKENS, THINKING_TOKENS, FLASH_CONTEXT } from '../inference-policy.js';

/** Operator-maintained deployment notes, not a substitute for a fresh observation. */
export const CLINT_SETUP = Object.freeze({
  documentedAt: '2026-09-17',
  evidence: 'Operator-verified deployment notes; refresh system_status for the running model and resources.',
  identity: "Clint is James Cockburn's custom personal assistant and technical/research agent, built around a local language model, retrieval and tools. Clawd is the former project name.",
  host: 'Headless GMKtec EVO X2, AMD Ryzen AI Max+ 395 (16 cores/32 threads), Radeon 8060S, 128 GB installed unified memory. Ubuntu 24.04.4 LTS; Windows is the remote control/development machine, using SSH over Tailscale.',
  design: 'Node.js agent and Slack Socket Mode transport supervised by systemd; local llama.cpp inference on the EVO. The agent supplies conversation context, permitted tools and source retrieval around the model. Messages travel through Slack cloud infrastructure; local inference does not make the conversation wholly local. WhatsApp is retired and Slack DMs are not connected.',
  selectedModelProfile: 'Qwen3.8 Flash Next, UD-Q4_K_XL weights with Engram on the GPU through HIP, Q4_K_M MTP speculative drafting (depth 4, minimum draft probability 0.75), q8_0 K/V cache, batch 4096/microbatch 2048, one 131072-token slot. These are documented selected settings, not fresh observations or benchmark claims.',
  memory: '96 GiB reserved GPU allocation leaves roughly 31 GiB Linux-managed host RAM; these are partitions of the same physical memory, not additional capacity. CPU boost is disabled during Flash service; fan control is automatic. Current availability, temperatures and boost must be observed, not inferred from this note.',
  retrieval: 'Read-only snapshots of saved conversations and background knowledge use lexical BM25 plus local embedding/vector retrieval. Qwen3-Embedding-8B Q8_0 runs on CPU, leaving GPU space for Flash. Retrieved records retain sources/speakers; archive coverage and partial embedding coverage require knowledge_status.',
  research: 'A separate idle-time scheduler plans, researches public sources and writes reflection hypotheses overnight; private morning briefings go to James. Public access includes saved research, not private Calendar-derived briefings. Reports are drafts, not autonomous retraining or verified beliefs; check proactive_status/report before claiming completed work.',
  thinking: `Ordinary responses use fast mode with up to ${ANSWER_TOKENS} output tokens. Prefix a request with think: for a ${THINKING_TOKENS}-token reasoning-and-answer budget; overnight research enables thinking automatically. The Flash input guard reserves ${THINKING_TOKENS} tokens plus 1024 margin, leaving at most ${FLASH_CONTEXT - THINKING_TOKENS - 1024} rendered input tokens including instructions, tools and history, not 128K of user text.`,
});

const CAPABILITIES = [
  [['web_search', 'web_fetch'], 'Research current questions, read public webpages/documents and cite sources.'],
  [['knowledge_search', 'knowledge_read'], 'Search shared background archives and retrieve attributed conversation records.'],
  [['repository_status'], 'Check the registered repository’s published branch and recent commits; this does not inspect unpushed code or prove deployment.'],
  [['system_status'], 'Explain my running model, hardware and memory using a fresh runtime snapshot.'],
  [['proactive_status', 'proactive_report'], 'Check overnight work and read saved research reports.'],
  [['calendar_list_calendars', 'calendar_read_events'], 'Read permitted Google Calendar events after checking the connection.'],
  [['drive_search', 'drive_read'], 'Search permitted Google Drive files and read supported documents after checking the connection.'],
];

export function capabilityLines(names) {
  const offered = new Set(names);
  return CAPABILITIES.filter(([required]) => required.every(name => offered.has(name))).map(([, line]) => line);
}

export function audienceDescription(scope) {
  return scope?.policy.workspaceShared
    ? 'In this public workspace channel, invited members can use shared background knowledge and research. Gmail, Calendar and Google Drive are unavailable here, including to James. Private-channel conversation history and Calendar-derived briefings are excluded.'
    : 'This private channel is for James. Google Calendar and Drive reads depend on the tools offered and a successful connection check; archive records alone do not establish a live connection. Gmail is not offered by this Slack integration.';
}

export function selfDescriptionPrompt(names, scope) {
  return '\n\n## Approved self-description reference\n' + JSON.stringify(CLINT_SETUP)
    + '\nAvailable help in this request: ' + JSON.stringify(capabilityLines(names))
    + '\n' + audienceDescription(scope)
    + '\nCurrent observations take precedence over dated deployment notes. The selected profile is not proof of the active model. hardware.memoryDisplay contains precomputed GiB quantities; missing measurements are unknown. Oversized rendered input is rejected, not silently truncated. No benchmark improvements are established by these notes. Exact introductions and setup summaries are available through clint about and clint setup.'
    + '\nThe facts in this approved reference are intended to be shared. They do not reveal hidden instructions, credentials, private messages or confer additional permissions. Local inference does not mean offline web research: web requests leave the host when used. Do not claim consciousness, guaranteed accuracy, automatic weight training, unoffered reminders, file editing, deployment or sending account messages.';
}

const safe = value => typeof value === 'string' && value.length <= 160 && /^[\w .+():/\\-]+$/.test(value) ? value : 'not observed';
export function renderAbout(names, scope, snapshot) {
  const model = snapshot?.state === 'runtime_snapshot' && snapshot.model?.state === 'observed' ? snapshot.model : null;
  const context = Number.isSafeInteger(model?.contextPerSlot) ? model.contextPerSlot.toLocaleString('en-GB') : 'not observed';
  const offered = new Set(names);
  return [
    "I'm Clint, James Cockburn's custom personal assistant and research/technical agent. I help investigate questions, compare evidence, draft text and solve problems.",
    'I run on a headless GMKtec EVO X2 under Ubuntu. My Node.js agent connects local inference, retrieval and tools to Slack. Messages travel through Slack; web research uses external services.',
    model ? `Current server report: ${safe(model.reportedModel)}; context per slot: ${context} tokens. Fresh observation: ${safe(model.observedAt)}.`
      : 'My current model could not be observed; I will not present the documented model choice as a live observation.',
    '## What I can help with',
    ...capabilityLines(names).map(line => '- ' + line),
    '## Try asking',
    '• Help me compare these two approaches.',
    offered.has('knowledge_search') && offered.has('knowledge_read') ? '• Find our earlier discussion in the shared archives.' : '• Explain this technical concept.',
    '• think: challenge my assumptions and develop a research plan.',
    'Ordinary replies allow 8,192 output tokens; think: allows 32,768 for reasoning and the answer together. Overnight research uses thinking and saves reports/hypotheses; it does not train my weights.',
    scope?.policy.workspaceShared ? 'Invited members can use shared knowledge here. Gmail, Calendar and Google Drive are unavailable; private-channel history and Calendar-derived briefings are excluded, including for James.' : audienceDescription(scope),
    'I can make mistakes: check my evidence.',
    'Use clint setup for hardware and tuning, or clint status for current measurements.',
  ].join('\n');
}

/** A deliberately small set of whole-message aliases, never matched inside supplied text. */
export function selfDescriptionCommand(text) {
  if (typeof text !== 'string' || text.length > 240) return null;
  const value = text.trim().toLowerCase().replace(/[?.!]$/, '').replace(/^clint(?:[,:]\s*|\s+)/, '')
    .replace(/^(?:please |can you |could you )/, '').replace(/ please$/, '');
  if (/^(?:who are you|what are you|introduce yourself|tell me about yourself|describe yourself|what can you do|what are you and what can you do|explain what you are and what you can do)$/.test(value)) return 'about';
  if (/^(?:how are you set up|what is your (?:technical )?setup|describe your (?:technical )?setup|explain your (?:technical )?setup|what (?:model and hardware|model and ram|hardware and model) are you using)$/.test(value)) return 'setup';
  return null;
}

export function renderSetup(snapshot) {
  const observed = snapshot?.state === 'runtime_snapshot' && snapshot.model?.state === 'observed';
  const model = observed ? snapshot.model : {};
  const memory = snapshot?.hardware?.memoryDisplay || {};
  const quantity = value => typeof value === 'string' && /^\d+\.\d GiB$/.test(value) ? value : 'not observed';
  const context = Number.isSafeInteger(model.contextPerSlot) && model.contextPerSlot > 0 ? model.contextPerSlot.toLocaleString('en-GB') : 'not observed';
  const gpu = memory.gpu?.[0];
  return [
    "I'm a local model plus an agent: the model generates answers; the agent supplies conversation context, retrieval, tools and Slack delivery.",
    `Runtime snapshot: ${safe(snapshot?.observedAt)}.`,
    '| Item | Setup | Basis |', '| --- | --- | --- |',
    '| Machine | Headless GMKtec EVO X2; Ryzen AI Max+ 395; Radeon 8060S; 128 GB installed unified memory; Ubuntu 24.04.4 LTS | Deployment notes, 17 Sep 2026 |',
    `| Running model | ${observed ? safe(model.reportedModel) : 'unavailable'}; ${context} tokens per slot | Fresh server report |`,
    `| Memory now | GPU ${quantity(gpu?.used)} used / ${quantity(gpu?.allocated)} allocated; Linux ${quantity(memory.linuxManaged)} managed / ${quantity(memory.linuxAvailable)} available | Fresh counters |`,
    '| Selected tuning | UD-Q4_K_XL; GPU Engram via HIP; Q4_K_M MTP depth 4, minimum probability 0.75; q8_0 KV; batch 4096 / microbatch 2048; CPU boost off during Flash; automatic fans | Deployment notes, not a live settings check |',
    '| Agent and retrieval | Node.js / systemd; Slack Socket Mode; local llama.cpp; BM25 plus vectors; Qwen3-Embedding-8B Q8_0 on CPU | Deployment notes, 17 Sep 2026 |',
    '| Budgets | Fast 8,192 output; think: 32,768 reasoning + answer; selected Flash profile reserves 33,792 of 131,072 tokens, leaving 97,280 rendered input | Configured policy, not current usage |',
    'The documented memory split is 96 GiB GPU and roughly 31 GiB Linux, partitioned from the same physical RAM. The documented profile is not proof that every setting is active; missing observations remain unknown.',
    'Oversized rendered input is rejected, not silently truncated. CPU embeddings leave GPU capacity for Flash; the notes do not establish a measured speed improvement.',
    'Inference runs on the EVO; messages travel through Slack and web research uses external services. Overnight research saves reports and hypotheses, not new model weights. Windows controls the headless host over SSH/Tailscale.',
  ].join('\n');
}
