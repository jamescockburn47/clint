import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNotable, formatNotable, composeDigest, composeSessionDigest } from '../src/moorstead/curate.js';

describe('moorstead/curate', () => {
  it('classifies join/leave/error/milestone as notable', () => {
    for (const type of ['join', 'leave', 'error', 'milestone']) {
      assert.equal(isNotable({ type, room: 'moor' }), true);
    }
  });

  it('classifies a normal edit routine, a protected-landmark edit notable', () => {
    assert.equal(isNotable({ type: 'edit', room: 'moor' }), false);
    assert.equal(isNotable({ type: 'edit', room: 'moor', detail: { protected: true } }), true);
  });

  it('formats a join with name and room', () => {
    assert.equal(formatNotable({ type: 'join', name: 'Alice', room: 'moor' }), '*Moorstead:* Alice joined moor.');
  });

  it('formats an error with its message', () => {
    const s = formatNotable({ type: 'error', name: 'Alice', room: 'moor', detail: { message: 'boom' } });
    assert.match(s, /Moorstead error/);
    assert.match(s, /boom/);
  });

  it('composes a digest with player count and edits per room', () => {
    const evs = [
      { type: 'join', name: 'Alice', room: 'moor' },
      { type: 'edit', name: 'Alice', room: 'moor' },
      { type: 'edit', name: 'Alice', room: 'moor' },
    ];
    const d = composeDigest(evs);
    assert.match(d, /1 active: Alice/);
    assert.match(d, /moor: 2 blocks changed/);
  });

  it('returns null digest when there are no events', () => {
    assert.equal(composeDigest([]), null);
  });

  it('composes a session digest for an emptied room', () => {
    assert.match(composeSessionDigest('moor', [{ type: 'edit', name: 'Alice', room: 'moor' }]), /moor is now empty/);
  });
});
