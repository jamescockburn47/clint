import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorCode } from '../src/error-code.js';
import { failureCode } from '../src/overnight/learning-worker.ts';

test('diagnostic codes preserve fixed classes and discard source-bearing fields', () => {
  for (const encode of [safeErrorCode, failureCode]) {
    assert.equal(encode(Object.assign(new Error('private filename'), { code: 'EEXIST' })), 'EEXIST');
    assert.equal(encode(new SyntaxError('Unexpected token in PRIVATE_JSON_SOURCE')), 'SyntaxError');
    assert.equal(encode(new Error('SYNTHETIC_PRIVATE_SOURCE_TEXT')), 'Error');
    assert.equal(encode({ message: 'xoxb-SYNTHETIC_SECRET', code: 'SYNTHETIC_PRIVATE_CODE', name: 'SYNTHETIC_PRIVATE_NAME' }), 'Error');
    assert.equal(encode({ message: 'EEXIST', name: 'private name' }), 'Error');
    assert.equal(encode(null), 'Error');
    assert.equal(encode('PRIVATE_THROWN_STRING'), 'Error');
  }
});
