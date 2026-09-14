import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendEvent } from '../overnight/events.js';

const RESEARCH_HOUR = 3;
const RESEARCH_MINUTE = 45;
const MAX_TOPICS = 3;
const MAX_TRANSCRIPT_LINES = 80;
const MAX_FETCHED_PAGES = 3;
const URL_PATTERN = /^   (https?:\/\/\S+)/gm;
const SEARCH_TIMEOUT_MS = 12_000;

export interface ResearchTopicReport {
  topic: string;
  findings: string;
  sources: string[];
}

export interface OvernightResearchReport {
  date: string;
  source: 'searxng';
  topics: ResearchTopicReport[];
}

type SearchFn = (input: { query: string; count?: number }) => Promise<string>;
type FetchFn = (input: { url: string }) => Promise<string>;
type ChatFn = (system: string, user: string, maxTokens?: number) => Promise<string | null>;
type ChooseTopicsFn = (transcript: string) => Promise<string[]>;

export interface RunOvernightResearchOptions {
  date: string;
  logDir?: string;
  overnightDir?: string;
  search?: SearchFn;
  fetchPage?: FetchFn;
  chat?: ChatFn;
  chooseTopics?: ChooseTopicsFn;
  /** Production queries come from the explicit public-topic allowlist, never private conversation inference. */
  approvedTopics?: string[];
}

let lastResearchDate: string | null = null;

async function importJsModule(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

async function defaultSearch(input: { query: string; count?: number }): Promise<string> {
  const config = (await importJsModule('../config.js')).default as { evoSearxngUrl?: string };
  const searxng = await searchSearxng(input.query, input.count ?? MAX_FETCHED_PAGES, config.evoSearxngUrl);
  if (searxng) return searxng;
  const duckduckgo = await searchDuckDuckGoHtml(input.query, input.count ?? MAX_FETCHED_PAGES);
  return duckduckgo ?? `No results found for "${input.query}".`;
}

async function defaultFetch(input: { url: string }): Promise<string> {
  const mod = await importJsModule('../tools/search.js');
  return (mod.webFetch as FetchFn)(input);
}

async function defaultChat(system: string, user: string, maxTokens?: number): Promise<string | null> {
  const mod = await importJsModule('../evo-llm.js');
  return (mod.evoSimpleChat as ChatFn)(system, user, maxTokens);
}

async function logResearchFailure(err: Error): Promise<void> {
  const mod = await importJsModule('../logger.js');
  const logger = mod.default as { error(fields: { err: string }, message: string): void };
  logger.error({ err: err.message }, 'overnight research failed');
}

function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function loadTranscript(date: string, logDir = join('data', 'conversation-logs')): Promise<string> {
  const dates = new Set([date, previousDate(date)]);
  let files: string[] = [];
  try {
    files = await readdir(logDir);
  } catch {
    // intentional: no conversation-log directory means there is nothing to research.
    return '';
  }

  const lines: string[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    if (!dates.has(file.slice(0, 10))) continue;
    const raw = await readFile(join(logDir, file), 'utf8').catch(() => {
      // intentional: skip unreadable rotated/partial conversation logs
      return '';
    });
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { sender?: string; text?: string; isBot?: boolean };
        if (entry.isBot || !entry.text || entry.text.length < 20) continue;
        lines.push(`${entry.sender ?? 'unknown'}: ${entry.text}`);
      } catch {
        // intentional: skip malformed conversation log lines
      }
    }
  }

  return lines.slice(-MAX_TRANSCRIPT_LINES).join('\n');
}

function parseTopicList(raw: string | null): string[] {
  if (!raw) return [];
  const firstBracket = raw.indexOf('[');
  const lastBracket = raw.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((topic): topic is string => typeof topic === 'string')
      .map((topic) => topic.trim())
      .filter(Boolean)
      .slice(0, MAX_TOPICS);
  } catch {
    return [];
  }
}

function fallbackTopics(transcript: string): string[] {
  const candidates = transcript
    .split('\n')
    .map((line) => line.replace(/^[^:]+:\s*/, '').trim())
    .filter((line) => line.length > 40)
    .filter((line) => /\b(research|check|find|how|what|why|latest|current|better|free|browser|web)\b/i.test(line));
  return [...new Set(candidates)].slice(0, MAX_TOPICS);
}

async function chooseTopics(transcript: string, chat: ChatFn): Promise<string[]> {
  const system = 'Select up to 3 overnight web research topics from the transcript. Output only a JSON array of short topic strings. Prefer topics James appears to care about and that benefit from current web research.';
  const user = `Transcript:\n${transcript.slice(-12000)}`;
  const raw = await chat(system, user, 300).catch(() => null);
  const parsed = parseTopicList(raw);
  return parsed.length > 0 ? parsed : fallbackTopics(transcript);
}

function extractSources(searchText: string): string[] {
  const urls = new Set<string>();
  for (const match of searchText.matchAll(URL_PATTERN)) {
    urls.add(match[1]!);
  }
  return [...urls].slice(0, MAX_FETCHED_PAGES);
}

function formatSearchResults(
  query: string,
  results: Array<{ title: string; url: string; content?: string }>,
): string | null {
  if (results.length === 0) return null;
  return results
    .map((result, index) => {
      const snippet = result.content ? `\n   ${result.content.slice(0, 1200)}` : '';
      return `${index + 1}. ${result.title || `Result for ${query}`}\n   ${result.url}${snippet}`;
    })
    .join('\n\n');
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Clawdbot/1.0)' },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function searchSearxng(
  query: string,
  count: number,
  baseUrl = 'http://localhost:8888',
): Promise<string | null> {
  try {
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json() as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const results = (data.results ?? [])
      .filter((result): result is { title: string; url: string; content?: string } => (
        typeof result.url === 'string' && typeof result.title === 'string'
      ))
      .slice(0, count);
    return formatSearchResults(query, results);
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeHtml(rawUrl);
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    const wrapped = url.searchParams.get('uddg');
    return wrapped ? decodeURIComponent(wrapped) : url.toString();
  } catch {
    return decoded;
  }
}

async function searchDuckDuckGoHtml(query: string, count: number): Promise<string | null> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const html = await res.text();
    const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const results: Array<{ title: string; url: string; content?: string }> = [];
    for (const match of html.matchAll(resultPattern)) {
      results.push({
        title: stripHtml(match[2] ?? ''),
        url: unwrapDuckDuckGoUrl(match[1] ?? ''),
        content: stripHtml(match[3] ?? ''),
      });
      if (results.length >= count) break;
    }
    return formatSearchResults(query, results);
  } catch {
    return null;
  }
}

async function researchTopic(
  topic: string,
  search: SearchFn,
  fetchPage: FetchFn,
  chat: ChatFn,
): Promise<ResearchTopicReport> {
  const searchText = await search({ query: topic, count: 6 });
  const sources = extractSources(searchText);
  const fetched = await Promise.all(
    sources.map(async (url) => `URL: ${url}\n${await fetchPage({ url })}`),
  );
  const system = 'Create a concise overnight research briefing with specific findings. Use only the supplied search results and fetched page text. Mention uncertainty. No hype.';
  const user = `Topic: ${topic}\n\nSearch results:\n${searchText}\n\nFetched pages:\n${fetched.join('\n\n---\n\n')}`;
  const findings = await chat(system, user, 700).catch(() => null);
  return {
    topic,
    findings: findings?.trim() || searchText,
    sources,
  };
}

export async function runOvernightResearch(
  opts: RunOvernightResearchOptions,
): Promise<OvernightResearchReport> {
  const overnightDir = opts.overnightDir ?? join('data', 'overnight');
  const transcript = opts.approvedTopics ? '' : await loadTranscript(opts.date, opts.logDir);
  const report: OvernightResearchReport = { date: opts.date, source: 'searxng', topics: [] };

  if (!transcript.trim() && !opts.approvedTopics?.length) {
    await appendEvent({
      stage: 'operations',
      phase: 'overnight-research',
      inputs: [],
      outputs: [],
      verdict: 'skipped',
      reason: opts.approvedTopics ? 'no public research topics configured' : 'no conversation text available for overnight research',
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    }, { date: opts.date, overnightDir });
    return report;
  }

  const chat = opts.chat ?? defaultChat;
  const topics = opts.approvedTopics ?? (opts.chooseTopics
    ? await opts.chooseTopics(transcript)
    : await chooseTopics(transcript, chat));
  const selectedTopics = topics.slice(0, MAX_TOPICS);
  const search = opts.search ?? defaultSearch;
  const fetchPage = opts.fetchPage ?? defaultFetch;

  report.topics = await Promise.all(
    selectedTopics.map((topic) => researchTopic(topic, search, fetchPage, chat)),
  );

  await mkdir(overnightDir, { recursive: true });
  await writeFile(
    join(overnightDir, `research-${opts.date}.json`),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  await appendEvent({
    stage: 'operations',
    phase: 'overnight-research',
    inputs: [`transcript_lines:${transcript.split('\n').length}`],
    outputs: [
      ...report.topics.map((topic) => `research:${topic.topic}`),
      ...report.topics.flatMap((topic) => topic.sources.slice(0, 2).map((source) => `source:${source}`)),
    ],
    verdict: report.topics.length > 0 ? 'ok' : 'skipped',
    reason: report.topics.length > 0
      ? `researched ${report.topics.length} topic${report.topics.length === 1 ? '' : 's'} using SearXNG`
      : 'no research topics selected',
    evidence_refs: [],
    rollback_ref: null,
    budget: { opus_sessions: 0, tokens: 0 },
  }, { date: opts.date, overnightDir });

  return report;
}

export async function checkOvernightResearch(
  todayStr: string,
  hours: number,
  minutes: number,
): Promise<void> {
  if (lastResearchDate === todayStr) return;
  if (hours !== RESEARCH_HOUR || minutes !== RESEARCH_MINUTE) return;
  lastResearchDate = todayStr;
  try {
    const { default: config } = await import('../config.js');
    await runOvernightResearch({ date: todayStr, approvedTopics: config.overnightResearchTopics });
  } catch (err) {
    await logResearchFailure(err as Error);
    throw err;
  }
}
