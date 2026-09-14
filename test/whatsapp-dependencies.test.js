import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('patched Signal protobuf preserves wire encoding and rejects truncated input', () => {
  const { WhisperMessage } = require('libsignal/src/protobufs.js');
  const message = { ephemeralKey: Buffer.alloc(33, 7), counter: 42, previousCounter: 3, ciphertext: Buffer.from('synthetic ciphertext') };
  const bytes = WhisperMessage.encode(WhisperMessage.create(message)).finish();
  const decoded = WhisperMessage.decode(bytes);
  assert.equal(decoded.counter, 42);
  assert.equal(decoded.previousCounter, 3);
  assert.deepEqual(Buffer.from(decoded.ciphertext), message.ciphertext);
  assert.deepEqual(Buffer.from(decoded.ephemeralKey), message.ephemeralKey);
  assert.throws(() => WhisperMessage.decode(bytes.subarray(0, bytes.length - 1)));
});
test('patched WhatsApp dependency chain signs and verifies keys and rejects tampering', async () => {
  const signal = require('libsignal');
  const identity = signal.keyhelper.generateIdentityKeyPair();
  const signed = signal.keyhelper.generateSignedPreKey(identity, 7);
  assert.equal(signal.curve.verifySignature(identity.pubKey, signed.keyPair.pubKey, signed.signature), true);
  const altered = Buffer.from(signed.keyPair.pubKey); altered[10] ^= 1;
  assert.equal(signal.curve.verifySignature(identity.pubKey, altered, signed.signature), false);
  const { proto } = await import('@whiskeysockets/baileys');
  const bytes = proto.Message.encode(proto.Message.create({ conversation: 'Synthetic transport fixture' })).finish();
  assert.equal(proto.Message.decode(bytes).conversation, 'Synthetic transport fixture');
});
