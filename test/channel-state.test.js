import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelState } from '../src/channel-state.ts';
import { isAuthorized } from '../src/http-auth.ts';

test('logged-out channel stays available for recovery without reconnect storms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const state = new ChannelState(async () => { attempts++; }, () => {});
  state.close(false); state.close(false); state.close(true);
  t.mock.timers.tick(60000);
  assert.equal(attempts, 0);
  assert.equal(state.status, 'needs_pairing');
});
test('reconnect scheduling is unique and shutdown cancels it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const state = new ChannelState(async () => { attempts++; }, () => {});
  state.close(false); state.close(false);
  t.mock.timers.tick(5000);
  assert.equal(attempts, 1);
  state.close(false); state.set('stopped'); t.mock.timers.tick(5000);
  assert.equal(attempts, 1);
});
test('all privileged HTTP paths require configured exact credentials', () => {
  const req = { url: '/debate', headers: {} };
  assert.equal(isAuthorized(req, ''), false);
  assert.equal(isAuthorized(req, 'fixture-secret'), false);
  assert.equal(isAuthorized({ ...req, headers: { authorization: 'Bearer fixture-secret' } }, 'fixture-secret'), true);
  assert.equal(isAuthorized({ ...req, url: '/?token=wrong' }, 'fixture-secret'), false);
});
test('transient reconnect startup failure retries and stops after shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const state = new ChannelState(async () => { attempts++; throw new Error('offline'); }, () => {});
  state.close(false);
  t.mock.timers.tick(5000);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.equal(attempts, 2);
  state.set('stopped');
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(50000);
  assert.equal(attempts, 2);
});
