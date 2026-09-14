/** Request one isolated code proposal against an actual recorded failure. No deployment. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryEvents } from './events.js';
import { createCodeProposal } from './code-proposal.js';
import { evoSimpleChat } from '../evo-llm.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [date, evidenceId, sourcePath] = process.argv.slice(2);
try {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !evidenceId || !sourcePath) {
    throw new Error('usage: npm run improve:code -- YYYY-MM-DD event-id src/allowed-file.js');
  }
  const dir = join(root, 'data', 'overnight');
  const event = (await queryEvents({ date, overnightDir: dir })).find(event => event.id === evidenceId);
  if (!event || !['failed', 'rejected'].includes(event.verdict)) throw new Error('observed_failure_not_found');
  const result = await createCodeProposal({ repoRoot: root, sourcePath,
    problem: `${event.stage}/${event.phase}: ${event.reason}`, evidenceIds: [event.id],
    proposalDir: join(dir, 'proposals'), dependencies: join(root, 'node_modules'),
    harness: join(root, 'scripts', 'sandbox'),
    generate: (system, input) => evoSimpleChat(system, input, 8000, 120_000),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'validation_failed' ? 1 : 0;
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', reason: (error as Error).message }));
  process.exitCode = 1;
}
