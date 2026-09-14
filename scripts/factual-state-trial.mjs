/** Bounded synthetic-only trial. Existing EVO service; no lifecycle mutations or tools. */
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { validateBundle, bindCandidate, decideState, decideBundle, prepareCandidates, renderState,
  assessmentSchema, Assessment } from '../src/knowledge/factual-state.js';
import { checkStatePrompt, factualStateVersion } from '../src/knowledge/factual-state-prompts.js';

const evidence = resolve('../evidence');
if (process.argv.slice(2).some(arg => !['--challenge', '--thinking', '--smoke', '--gpt', '--gemma', '--flash'].includes(arg))) throw new Error('unsupported_trial_option');
if (process.argv.includes('--smoke') && process.argv.includes('--challenge')) throw new Error('ambiguous_trial_split');
const thinking = process.argv.includes('--thinking');
const gpt = process.argv.includes('--gpt');
const gemma = process.argv.includes('--gemma');
const flash = process.argv.includes('--flash');
if (flash && (gpt || gemma || thinking || process.argv.includes('--challenge'))) throw new Error('flash_development_only');
if ((gpt && gemma) || ((gpt || gemma) && thinking)) throw new Error('ambiguous_model_settings');
const split = process.argv.includes('--smoke') ? 'smoke' : process.argv.includes('--challenge') ? 'challenge' : 'development';
const suffix = (flash ? 'flash-' : gemma ? 'gemma-' : gpt ? 'gpt-' : thinking ? 'thinking-' : '') + split;
const port = gpt || gemma || flash ? 11437 : 11435;
const out = resolve(evidence, `owner-identity-${suffix}-results-20260914.jsonl`);
const rawOut = resolve(evidence, `owner-identity-${suffix}-responses-20260914.jsonl`);
const pinPath = resolve(evidence, `owner-identity-${suffix}-trial-pin-20260914.json`);
const attemptPath = resolve(evidence, `owner-identity-${suffix}-attempt-20260914.jsonl`);
if ([out, rawOut, pinPath, attemptPath].some(existsSync)) throw new Error('trial_receipt_exists');
writeFileSync(attemptPath, JSON.stringify({ startedAt: new Date().toISOString(), split, suffix }) + '\n', { flag: 'wx' });
process.on('uncaughtException', error => {
  appendFileSync(attemptPath, JSON.stringify({ failedAt: new Date().toISOString(), error: error.code ?? error.name }) + '\n');
  process.exit(1);
});
let servingIdentity = null;
if (flash) {
  servingIdentity = JSON.parse(readFileSync(resolve(evidence, 'flash-serving-contract-20260914.json')));
  if (!servingIdentity.passed || servingIdentity.model !== 'qwen3.8-flash-next') throw new Error('flash_serving_contract_failed');
  const remote = `import hashlib,json,subprocess,urllib.request
with urllib.request.urlopen('http://127.0.0.1:11437/props',timeout=5) as response:p=json.load(response)
ids=subprocess.run(['docker','ps','-q','--filter','label=clint.test.run=20260914-flashq4-stream'],capture_output=True,text=True,check=True,timeout=10).stdout.split()
assert len(ids)==1
d=json.loads(subprocess.run(['docker','inspect',ids[0]],capture_output=True,text=True,check=True,timeout=10).stdout)[0]
print(json.dumps({'model':p['model_alias'],'slots':p['total_slots'],'context':p['default_generation_settings']['n_ctx'],'build':p.get('build_info'),'templateSha256':hashlib.sha256(str(p.get('chat_template')).encode()).hexdigest(),'image':d['Image']}))
`;
  const fresh = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    'evo-tailscale', 'python3 -'], { input: Buffer.from(remote), timeout: 30000 }).toString());
  for (const key of ['model', 'slots', 'context', 'build', 'templateSha256']) {
    if (JSON.stringify(fresh[key]) !== JSON.stringify(servingIdentity[key])) throw new Error('flash_serving_identity_changed');
  }
  const runtime = JSON.parse(readFileSync(resolve(evidence, 'flash-runtime-probe-20260914.json')));
  if (fresh.image !== runtime.image) throw new Error('flash_runtime_image_changed');
  servingIdentity = { ...servingIdentity, fresh };
}
if (gpt || gemma) {
  const remote = `import hashlib,json,urllib.request
base='http://127.0.0.1:11437'
with urllib.request.urlopen(base+'/props',timeout=5) as response:props=json.load(response)
assert props['model_alias']=='${gemma ? 'gemma-4-31b' : 'gpt-oss-120b'}' and props['total_slots']==1
assert props['default_generation_settings']['n_ctx']==32768
payload={'messages':[{'role':'system','content':'Synthetic system instruction.'},{'role':'user','content':'Synthetic template check.'}],${gemma ? "'chat_template_kwargs':{'enable_thinking':False}" : "'reasoning_effort':'medium'"}}
request=urllib.request.Request(base+'/apply-template',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=5) as response:template=json.load(response)['prompt']
${gemma ? "assert '<|turn>system' in template and '<|think|>' not in template" : "assert '<|start|>' in template and '<|message|>' in template and 'Reasoning: medium' in template"}
print(json.dumps({'model':props['model_alias'],'slots':props['total_slots'],'context':32768,'build':props.get('build_info'),'templateSha256':hashlib.sha256(str(props.get('chat_template')).encode()).hexdigest(),'format':'${gemma ? 'gemma4' : 'harmony'}','mode':'${gemma ? 'nonthinking' : 'medium'}'}))
`;
  servingIdentity = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    'evo-tailscale', 'python3 -'], { input: Buffer.from(remote), timeout: 20000, maxBuffer: 256000 }).toString());
}
const fixtureBytes = readFileSync(resolve(evidence, `owner-identity-${split}-20260914.json`));
const fixtures = JSON.parse(fixtureBytes);
const deadline = Date.now() + 15 * 60 * 1000;
const settings = { model: 'qwen3.8-27b', max_tokens: 1024, temperature: 0.7, top_p: 0.8,
  top_k: 20, min_p: 0, presence_penalty: 1.5, repeat_penalty: 1, seed: 20260914,
  chat_template_kwargs: { enable_thinking: false }, reasoning_format: 'deepseek', stream: false };
if (flash) settings.model = 'qwen3.8-flash-next';
if (thinking) Object.assign(settings, { max_tokens: 3072, temperature: 1.0, top_p: 0.95,
  presence_penalty: 0, chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'low' });
if (gpt) {
  delete settings.chat_template_kwargs;
  Object.assign(settings, { model: 'gpt-oss-120b', max_tokens: 3072, temperature: 1.0,
    top_p: 1.0, top_k: 0, presence_penalty: 0, reasoning_effort: 'medium', reasoning_format: 'auto' });
}
if (gemma) Object.assign(settings, { model: 'gemma-4-31b', temperature: 1.0,
  top_p: 0.95, top_k: 64, presence_penalty: 0, reasoning_format: 'auto' });
let requests = 0;
function callModel(system, data, schema) {
  if (++requests > 48 || Date.now() > deadline) throw new Error('trial_budget_exhausted');
  const payload = { ...settings, messages: [{ role: 'system', content: system },
    { role: 'user', content: JSON.stringify(data) }],
    response_format: { type: 'json_schema', json_schema: { name: 'state', strict: true, schema } } };
  // Base64 is transport encoding, not shell interpolation; the remote script is stdin.
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const remote = `import base64,json,time,urllib.request
body=base64.b64decode('${encoded}')
request=urllib.request.Request('http://127.0.0.1:${port}/v1/chat/completions',data=body,headers={'Content-Type':'application/json'})
start=time.monotonic()
row={}
try:
 with urllib.request.urlopen(request,timeout=60) as response:data=json.load(response)
 choice=data['choices'][0]; message=choice['message']; answer=message.get('content') or ''
 row={'answer':answer,'seconds':round(time.monotonic()-start,3),'finish':choice['finish_reason'],'reasoning_chars':len(message.get('reasoning_content') or message.get('reasoning') or ''),'usage':data.get('usage')}
 print(json.dumps(row),flush=True)
 if any(tag in answer for tag in ['<think>','</think>','<|channel|>','<|start|>','<|channel>','<channel|>','<|turn>']):raise RuntimeError('protocol_leak')
 if choice['finish_reason'] != 'stop':raise RuntimeError('incomplete_generation')
 row['result']=json.loads(answer)
except Exception as error:row['error']=type(error).__name__
print(json.dumps(row),flush=True)
`;
  let stdout = ''; let transportError = null;
  try {
    stdout = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      'evo-tailscale', 'python3 -'], { input: Buffer.from(remote), timeout: 75000, maxBuffer: 256000 }).toString();
  } catch (error) { stdout = error.stdout?.toString() ?? ''; transportError = error.code ?? error.name; }
  appendFileSync(rawOut, JSON.stringify({ request: requests, stdout, transportError }) + '\n');
  const lines = stdout.trim().split('\n');
  const result = JSON.parse(lines.at(-1));
  if (transportError || result.error || !Object.hasOwn(result, 'result')) throw new Error('model_call_failed');
  Assessment.parse(result.result);
  if (flash && result.reasoning_chars !== 0) throw new Error('flash_nonthinking_contract_failed');
  return result;
}
writeFileSync(pinPath, JSON.stringify({
  at: new Date().toISOString(), version: factualStateVersion, settings, servingIdentity,
  fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  coreSha256: createHash('sha256').update(readFileSync('src/knowledge/factual-state.js')).digest('hex'),
  checkPromptSha256: createHash('sha256').update(checkStatePrompt).digest('hex'),
  boundary: 'Only synthetic fixture records sent to existing local EVO inference; labels excluded',
}, null, 2), { flag: 'wx' });
for (const fixture of [...fixtures.cases, ...fixtures.forged]) {
  const bundle = validateBundle({ question: fixture.question, sources: fixture.sources });
  let row;
  const assessed = [];
  try {
    const candidates = fixture.candidate ? [fixture.candidate] : prepareCandidates(bundle);
    for (const candidate of candidates) {
      const bound = bindCandidate(bundle, candidate);
      const check = bound.accepted ? callModel(checkStatePrompt, { ...bundle, candidate }, assessmentSchema) : null;
      assessed.push({ candidate, assessment: check?.result ?? null, check });
    }
    const state = fixture.candidate ? decideState(bundle, fixture.candidate, assessed[0].assessment)
      : decideBundle(bundle, assessed);
    row = { id: fixture.id, expected: fixture.expected, assessed, state,
      answer: renderState(state), stateMatches: state.state === fixture.expected };
  } catch (error) {
    // No prompt/response material in errors; infrastructure failure is never a passed abstention.
    row = { id: fixture.id, expected: fixture.expected, assessed, error: error.code ?? error.name, stateMatches: false };
  }
  appendFileSync(out, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ id: row.id, state: row.state?.state, reason: row.state?.reason, error: row.error, matches: row.stateMatches }));
}
console.log(JSON.stringify({ completed: true, requests }));
appendFileSync(attemptPath, JSON.stringify({ completedAt: new Date().toISOString(), requests }) + '\n');
