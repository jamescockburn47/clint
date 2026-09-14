// EVO X2 local model integration via llama.cpp (OpenAI-compatible API)
// Handles tool calling and response generation locally, falling back to Claude
import config from './config.js';
import logger from './logger.js';
import { executeTool } from './tools/handler.js';
import { getWorkingKnowledge, warmFromQuery } from './lquorum-rag.js';
import { evoFetch, checkLlamaHealth } from './evo-client.js';
import { TIMEOUTS, LIMITS } from './constants.js';

// Convert Anthropic-style tool definitions to OpenAI function-calling format
function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Build a lean system prompt for EVO X2 — tailored per activity category
function buildEvoSystemPrompt(category = null) {
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });

  let base = `You are Clint, James's personal assistant on WhatsApp. Be concise and direct.

Today is ${dateStr}, ${timeStr} (Europe/London).`;

  if (category === 'recall') {
    base += `\n\n## Rules
- Answer from the memories provided below. If no relevant memory exists, say "I don't have that stored."
- Do NOT guess or infer — only report what is in your memories.
- Keep messages short. Use bullet points. Bold key info with *asterisks*.`;
  } else if (category === 'conversational') {
    base += `\n\n## Rules
- Chat naturally. Be helpful, witty, concise.
- This is WhatsApp — keep it short.`;
  } else {
    base += `\n\n## Rules
- Use tools to answer questions. Do not guess — call the tool and report what it returns.
- For dates: compute relative dates from today. Use YYYY-MM-DD format. Use ISO 8601 for datetimes.
- UK train station CRS codes: KGX=Kings Cross, YRK=York, LDS=Leeds, EDB=Edinburgh, DAR=Darlington.

## Formatting tool results
- Report ONLY what the tool returned. Nothing more, nothing less.
- Use the EXACT titles, dates, times, and locations from the tool result.
- Do NOT add commentary, notes, warnings, or editorial observations about the data.
- Do NOT add suggestions or follow-up questions unless directly relevant.
- Do NOT invent, embellish, or infer any information not present in the tool result.
- Do NOT describe events as "continuing" or "recurring" unless the tool result explicitly says so.
- If an event spans multiple days, state the start and end date/time once — do not list it on each day.
- Keep messages short. Use bullet points. Bold key info with *asterisks*.
- This is WhatsApp — not an essay.`;
  }

  base += `\n\n## Who you are
You are Clint, James's personal assistant and technical/research agent. Use system_status and overnight_status to establish current capabilities and failures. Dreaming means reviewing attributed statements and observed failures, not consciousness or proof of self-improvement. Only the defined report-presentation policy applies automatically; executable code proposals require review. Do not claim an unavailable service is working.`;

  base += `\n\n## Memories
You may have background knowledge about James injected below. Use it to understand context (e.g. preferences, people, places) but do NOT mix memory facts into tool result summaries. Memories inform your understanding — tool results are the data you report.`;

  return base;
}

// Validate tool call parameters before executing — local models can hallucinate args
function validateToolParams(toolName, params) {
  if (!params || typeof params !== 'object') return 'missing or invalid parameters';

  const dateFields = ['date', 'startDate', 'endDate', 'start_date', 'end_date', 'due_date', 'dueDate'];
  for (const field of dateFields) {
    if (params[field] && typeof params[field] === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}/.test(params[field])) {
        return `invalid date format for ${field}: ${params[field]}`;
      }
    }
  }

  const required = {
    'calendar_create_event': ['summary', 'start'],
    'todo_add': ['text'],
    'gmail_draft': ['to', 'subject'],
    'train_departures': ['from', 'to'],
    'memory_search': ['query'],
    'web_search': ['query'],
  };
  const reqs = required[toolName];
  if (reqs) {
    for (const r of reqs) {
      if (!params[r]) return `missing required parameter: ${r}`;
    }
  }

  return null;
}

// Full tool-calling response via EVO X2's llama-server (OpenAI-compatible API)
export async function getEvoToolResponse(context, tools, senderJid, memoryFragment = '', category = null, imageData = null) {
  const baseUrl = config.evoLlmUrl;
  const openAITools = toOpenAITools(tools);
  warmFromQuery(context);
  const lquorumContext = getWorkingKnowledge();
  const systemPrompt = buildEvoSystemPrompt(category) + memoryFragment + (lquorumContext ? '\n\n' + lquorumContext : '');

  // Build user content — text or text + image for VL model
  let userContent;
  const isVisionQuery = !!imageData;
  if (imageData) {
    const base64 = imageData.source?.data || (Buffer.isBuffer(imageData) ? imageData.toString('base64') : null);
    const mediaType = imageData.source?.media_type || 'image/jpeg';
    userContent = [
      { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
      { type: 'text', text: context || 'Describe this image in detail. Extract any text, numbers, names, dates visible.' },
    ];
    logger.info('sending image to EVO VL model');
  } else {
    userContent = context;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  try {
    let res = await evoFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages,
        // No tools for vision queries — model should respond directly about the image
        tools: (!isVisionQuery && openAITools.length > 0) ? openAITools : undefined,
        temperature: 0.3,
        max_tokens: isVisionQuery ? 2000 : 1000,
        repeat_penalty: 1.3,
        cache_prompt: true,
      }),
      timeout: TIMEOUTS.EVO_REQUEST,
    });

    let data = await res.json();
    let msg = data.choices?.[0]?.message || {};

    // Tool use loop
    let loopCount = 0;
    const maxLoops = 5;

    while (msg.tool_calls && msg.tool_calls.length > 0 && loopCount < maxLoops) {
      loopCount++;
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        const toolName = fn.name;
        let toolInput;
        try {
          toolInput = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
        } catch {
          toolInput = {};
        }

        const validationError = validateToolParams(toolName, toolInput);
        if (validationError) {
          logger.warn({ tool: toolName, error: validationError, source: 'evo' }, 'tool params rejected');
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${validationError}. Please fix and try again.` });
          continue;
        }

        logger.info({ tool: toolName, input: toolInput, source: 'evo' }, 'local tool call');
        let result = await executeTool(toolName, toolInput, senderJid);
        logger.info({ tool: toolName, chars: result.length, source: 'evo' }, 'local tool result');

        if (result.length > LIMITS.MAX_TOOL_RESULT) {
          result = result.slice(0, LIMITS.MAX_TOOL_RESULT) + '\n[...truncated]';
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }

      // Send tool results back for final response
      try {
        res = await evoFetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({
            messages,
            tools: openAITools.length > 0 ? openAITools : undefined,
            temperature: 0.3,
            max_tokens: 1000,
            repeat_penalty: 1.3,
            cache_prompt: true,
          }),
          timeout: TIMEOUTS.EVO_REQUEST,
        });
      } catch { break; }

      data = await res.json();
      msg = data.choices?.[0]?.message || {};
      logger.info({ loop: loopCount, source: 'evo' }, 'tool loop');
    }

    const content = msg.content;
    if (!content) return null;

    // Extract timing from llama-server response
    const timings = data.timings || data.usage || {};
    logger.info({
      model: data.model || 'evo-local',
      chars: content.length,
      toolLoops: loopCount,
      promptTokens: timings.prompt_tokens || data.usage?.prompt_tokens,
      completionTokens: timings.completion_tokens || data.usage?.completion_tokens,
    }, 'evo tool response');

    return content;
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn({ timeout: TIMEOUTS.EVO_REQUEST }, 'evo tool call timed out');
      return null;
    }
    logger.warn({ err: err.message }, 'evo tool call failed');
    return null;
  }
}

// Re-export llama health check from evo-client (backwards compat)
export { checkLlamaHealth as checkEvoHealth } from './evo-client.js';

// ── Granite-Docling structured document parsing ──────────────────────────────

const DOCLING_URL = config.evoDoclingUrl;

/**
 * Parse a PDF page image via Granite-Docling on EVO X2.
 * Takes a PNG/JPEG buffer of a rendered page, returns structured DocTags as text.
 */
async function parsePageViaDocling(imageBuffer) {
  const base64 = imageBuffer.toString('base64');

  try {
    const res = await evoFetch(`${DOCLING_URL}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            { type: 'text', text: 'Convert this document page to DocTags.' },
          ],
        }],
        temperature: 0.0,
        max_tokens: 4000,
      }),
      timeout: TIMEOUTS.DOCLING_PARSE,
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.warn({ err: err.message }, 'Granite-Docling page parse failed');
    return null;
  }
}

/**
 * Convert DocTags output to clean markdown.
 * DocTags format: <loc_x1><loc_y1><loc_x2><loc_y2>text content
 */
function docTagsToMarkdown(docTags) {
  if (!docTags) return null;

  // Strip location tags and extract text content
  let md = docTags
    .replace(/<loc_\d+>/g, '')
    .replace(/<otsl>/g, '')
    .replace(/<\/otsl>/g, '')
    .replace(/<fcel>/g, '| ')
    .replace(/<\/fcel>/g, ' ')
    .replace(/<ecel>/g, '| ')
    .replace(/<\/ecel>/g, ' ')
    .replace(/<nl>/g, '|\n')
    .replace(/<caption>/g, '*')
    .replace(/<\/caption>/g, '*')
    .replace(/<section-header[^>]*>/g, '## ')
    .replace(/<\/section-header>/g, '')
    .replace(/<title>/g, '# ')
    .replace(/<\/title>/g, '')
    .replace(/<text>/g, '')
    .replace(/<\/text>/g, '')
    .replace(/<list-item>/g, '- ')
    .replace(/<\/list-item>/g, '')
    .replace(/<table>/g, '')
    .replace(/<\/table>/g, '')
    .replace(/<figure>/g, '[Figure]')
    .replace(/<\/figure>/g, '')
    .replace(/<page_break>/g, '\n---\n')
    .replace(/<[^>]+>/g, '') // catch remaining tags
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return md || null;
}

/**
 * Parse a PDF via Granite-Docling: render pages to images, parse each, return structured markdown.
 * Requires pdftoppm on the Pi (poppler-utils).
 */
export async function parseDocumentWithDocling(pdfBuffer, fileName, maxPages = 10) {
  const { execSync } = await import('child_process');
  const { writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  const tmpDir = join('/tmp', `docling_${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const pdfPath = join(tmpDir, 'input.pdf');
  writeFileSync(pdfPath, pdfBuffer);

  try {
    // Render PDF pages to PNG images using pdftoppm
    execSync(`pdftoppm -png -r 200 -l ${maxPages} "${pdfPath}" "${join(tmpDir, 'page')}"`, { timeout: 30000 });

    const pageFiles = readdirSync(tmpDir)
      .filter(f => f.startsWith('page') && f.endsWith('.png'))
      .sort();

    if (pageFiles.length === 0) {
      logger.warn({ fileName }, 'pdftoppm produced no page images');
      return null;
    }

    logger.info({ fileName, pages: pageFiles.length }, 'rendering PDF pages for Docling');

    const allMarkdown = [];
    for (const pageFile of pageFiles) {
      const imgBuffer = readFileSync(join(tmpDir, pageFile));
      const docTags = await parsePageViaDocling(imgBuffer);
      const md = docTagsToMarkdown(docTags);
      if (md) allMarkdown.push(md);
    }

    // Cleanup
    for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f));
    try { execSync(`rmdir "${tmpDir}"`); } catch { /* intentional: temp dir cleanup is best-effort */ }

    if (allMarkdown.length === 0) return null;

    const result = allMarkdown.join('\n\n---\n\n');
    logger.info({ fileName, pages: allMarkdown.length, chars: result.length }, 'PDF parsed via Granite-Docling');
    return result;
  } catch (err) {
    logger.warn({ err: err.message, fileName }, 'Granite-Docling PDF parsing failed');
    // Cleanup on error
    try {
      for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f));
      execSync(`rmdir "${tmpDir}"`);
    } catch { /* intentional: temp dir cleanup on error path is best-effort */ }
    return null;
  }
}

// Summarise document text via EVO X2 — saves Claude tokens
export async function summariseDocument(text, fileName, maxOutputTokens = 500) {
  try {
    const res = await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are a document summariser. Produce a concise but thorough summary preserving key facts, figures, names, dates, arguments, and conclusions. Do not add commentary or opinion. If the document has structure (sections, headings), preserve that structure in condensed form.' },
          { role: 'user', content: `Summarise this document (${fileName}):\n\n${text}` },
        ],
        temperature: 0.1,
        max_tokens: maxOutputTokens,
        cache_prompt: true,
      }),
      timeout: TIMEOUTS.DOC_SUMMARISE,
    });

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (summary) {
      logger.info({ fileName, inputChars: text.length, summaryChars: summary.length }, 'document summarised via EVO');
    }
    return summary || null;
  } catch (err) {
    logger.warn({ err: err.message, fileName }, 'EVO document summarisation error');
    return null;
  }
}

// ── Simple EVO chat completion (no tools) — for topic segmentation etc ──────

/**
 * Send a simple chat completion to the EVO 30B model.
 * No tool calling, no loops — just system + user → text response.
 * Used for topic segmentation in group analysis modes (free, fast).
 *
 * @param {string} systemPrompt - System message
 * @param {string} userMessage - User message
 * @param {number} maxTokens - Max output tokens (default 800)
 * @returns {string|null} - Response text, or null on failure
 */
/** @param {string} systemPrompt @param {string} userMessage @param {number} maxTokens @param {number} timeoutMs */
export async function evoSimpleChat(systemPrompt, userMessage, maxTokens = 800, timeoutMs = TIMEOUTS.DOC_SUMMARISE) {
  try {
    const res = await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
        cache_prompt: true,
      }),
      timeout: timeoutMs, // default DOC_SUMMARISE 30s; callers handling large prompts pass MEMORY_EXTRACT or higher
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text) {
      logger.info({ inputChars: userMessage.length, outputChars: text.length }, 'EVO simple chat completed');
    }
    return text || null;
  } catch (err) {
    logger.warn({ err: err.message }, 'EVO simple chat error');
    return null;
  }
}

// ── 4B classifier — category + needsPlan ────────────────────────────────────

const PLANNER_CLASSIFY_PROMPT = `You are a message classifier for a WhatsApp assistant called Clint.
Clint is a personal and legal assistant for James, a senior commercial litigation solicitor.
You MUST respond in English only. Output JSON only, no thinking, no explanation.

Classify this message into ONE category and determine if it needs multi-step planning.

Categories: calendar, task, travel, email, recall, planning, conversational, general_knowledge, system

- "calendar" = checking schedule, creating/updating events, what's on, free time
- "task" = todos, reminders, task lists
- "travel" = trains, hotels, flights, fares, accommodation
- "email" = reading/sending/drafting emails, inbox
- "recall" = asking about something previously discussed, stored facts, memories
- "planning" = complex multi-step reasoning, organising, strategy, anything needing 2+ tools
- "conversational" = chat, banter, greetings, opinions
- "general_knowledge" = factual questions, current info, web lookups, legal knowledge
- "system" = questions about the bot itself, architecture, status

needsPlan is TRUE when answering well requires information from 2+ different sources or tools:
- Overview requests: "what do I need to do this week" (needs calendar + todos + memory)
- Preparation: "prepare me for Friday" (needs calendar + todos + memory + possibly email)
- Briefing: "catch me up on X" (needs memory + email + possibly calendar)
- Multiple actions: "add a todo and check my calendar"
- Research + action: "find what the group said about X and summarise it"
- Conditional: "if I'm free Thursday, book the 0930"
- Cross-tool synthesis: "what have I been working on this week"
- Any request where a GOOD answer requires combining data from multiple tools

needsPlan is FALSE for:
- Single tool calls: "what's on my calendar tomorrow" (just calendar)
- Conversational: "what do you think about X"
- Simple lookups: "search for Y" (just web_search)
- Simple questions: "who is X"
- Single actions: "add a todo for Friday" (just todo_add)

Output JSON only, no other text, no thinking:
{"category": "...", "needsPlan": true, "planReason": "brief reason", "confidence": 0.95}`;

/**
 * Classify via 4B model (port 8085) — category + needsPlan.
 * Returns { category, needsPlan, planReason, confidence } or null on failure.
 */
export async function classifyVia4B(text) {
  try {
    const res = await evoFetch(`${config.evoPlannerUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: PLANNER_CLASSIFY_PROMPT },
          { role: 'user', content: text + ' /no_think' },
        ],
        temperature: 0,
        max_tokens: 100,
        cache_prompt: true,
      }),
      timeout: TIMEOUTS.EVO_CLASSIFIER,
    });

    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    // Parse JSON — handle markdown-wrapped JSON (```json ... ```)
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      logger.warn('4B classifier returned non-JSON');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate fields
    const validCategories = new Set([
      'calendar', 'task', 'travel', 'email', 'recall',
      'planning', 'conversational', 'general_knowledge', 'system',
    ]);

    if (!validCategories.has(parsed.category)) {
      logger.warn('4B classifier returned invalid category');
      return null;
    }

    return {
      category: parsed.category,
      needsPlan: !!parsed.needsPlan,
      planReason: parsed.planReason || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    };
  } catch (err) {
    logger.warn('4B classifier failed');
    return null;
  }
}

// Classify message via EVO X2's 0.6B classifier llama-server (engagement gating only)
export async function classifyViaEvo(text, systemPrompt) {
  try {
    const res = await evoFetch(`${config.evoClassifierUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0,
        max_tokens: 10,
        cache_prompt: true,
      }),
      timeout: TIMEOUTS.EVO_CLASSIFIER,
    });

    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  } catch (err) {
    throw err;
  }
}

// Keep-alive ping — exercises inference path every scheduler tick (60 s)
// to prevent GPU power-state downclock during idle periods. With
// Qwen3.6-27B now on :8080 as the default chat AND classifier model, the
// prompt cache being warm matters for first-response latency.
//
// Strategy: 60 s cadence (set by scheduler.js), max_tokens=1, and a
// short realistic prompt so the token path is exercised rather than a
// health-check shortcut. Cost per ping is ~100-200 ms on warm
// hardware; on cold GPU the first ping after a quiet period is ~1 s
// (exactly what we want — it's the cost we're paying to keep the
// follow-up user request cheap).
//
// cache_prompt=true instructs llama-server to hold the KV-cache prefix
// across calls. The ping itself primes the system-prompt-less short
// path; real traffic uses its own prefixes on top. The main value of
// this call is GPU-clock warming, not cache priming.
// 2026-04-24 redesign: warm BOTH llama-server instances we depend on
// every 60 s. Previous version only pinged :8080, leaving :8085 (4B
// classifier) cold — which caused the 5 s timeouts on classifyVia4B
// after idle windows (PR #40 bumped the timeout but the real fix is
// keeping the process warm).
//
// Each ping uses a short system prompt matching the SHAPE of a real
// classifier / chat system prompt. Combined with cache_prompt=true,
// this keeps the KV-cache prefix warm so the first real user request
// pays only the user-message-delta prefill, not the full 13K cortex
// prefill.
//
// max_tokens=1 means we decode exactly one token per ping — cheap
// enough to run every minute even on Q6_K 27B. Net saving on
// user-visible latency after a quiet window: ~0.5-1 s per cold-start.
const CLINT_WARM_SYSTEM_27B = 'You are Clint, a WhatsApp admin assistant. Respond briefly.';
const CLASSIFIER_WARM_SYSTEM_4B = 'You are a message classifier. Output JSON only. Respond briefly.';

async function warmOne(url, systemText, label) {
  try {
    await evoFetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: 'ok' },
        ],
        max_tokens: 1,
        temperature: 0,
        cache_prompt: true,
      }),
      timeout: TIMEOUTS.EVO_HEALTH_CHECK,
    });
    logger.info({ label }, 'warm ping ok');
  } catch {
    // Target offline — scheduler retries next tick. No warn-spam.
  }
}

export async function keepEvoWarm() {
  // Parallel so the tick cost is one cold-start worst-case, not two.
  await Promise.all([
    warmOne(config.evoLlmUrl, CLINT_WARM_SYSTEM_27B, 'evo-main-27b'),
    warmOne(config.evoPlannerUrl, CLASSIFIER_WARM_SYSTEM_4B, 'evo-planner-4b'),
  ]);
}
