import { currentConversation } from '../conversation-context.js';
import { ownerActionsAllowed } from '../owner-actions.js';
import { taskAction } from './owner-store.js';

const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const OWNER_TASK_DEFINITIONS = [
  { name: 'task_save', description: 'Save one local task requested by the owner. This records work to do; it does not perform it. At most one task_save per user message.',
    input_schema: schema({ title: { type: 'string', minLength: 1, maxLength: 200 }, details: { type: 'string', maxLength: 12000 } }) },
  { name: 'task_list', description: 'Read the newest 100 tasks recorded for this owner in this conversation. Recorded completion is not independent proof of work.', input_schema: schema({}) },
  { name: 'task_read', description: 'Read one saved local task in full, including its original request. This is a record, not proof of execution.',
    input_schema: schema({ id: { type: 'string', pattern: '^[a-f0-9]{24}$' } }) },
  { name: 'task_set_status', description: 'Record the owner-requested task status: queued, completed or cancelled. Does not execute, cancel an external job or independently verify work. One status change per user message.',
    input_schema: schema({ id: { type: 'string', pattern: '^[a-f0-9]{24}$' }, status: { type: 'string', enum: ['queued', 'completed', 'cancelled'] } }) },
];
export const OWNER_TASK_HANDLERS = OWNER_TASK_DEFINITIONS.map(({ name }) => [name, async input => {
  const scope = currentConversation();
  if (!ownerActionsAllowed(scope)) throw Error('task_permission_denied');
  return JSON.stringify(taskAction(scope.taskStorePath, scope, name, input));
}]);
