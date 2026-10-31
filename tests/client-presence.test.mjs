import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createClientPresence, validClientId } from '../lib/client-presence.mjs';

test('validates tab identities before registering presence', () => {
  assert.equal(validClientId('1b4e28ba-2fa1-11d2-883f-0016d3cca427'), true);
  assert.equal(validClientId('not-a-client'), false);
  assert.equal(validClientId({}), false);
});

test('waits for every tab and cancels a pending stop when Finance is reopened', async () => {
  let stops = 0;
  const presence = createClientPresence({ onEmpty: () => { stops += 1; }, leaseMs: 500, shutdownGraceMs: 35, startupGraceMs: 500 });
  const first = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const second = '2b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const reopened = '3b4e28ba-2fa1-11d2-883f-0016d3cca427';

  presence.heartbeat(first);
  presence.heartbeat(second);
  presence.release(first);
  await delay(45);
  assert.equal(stops, 0);
  assert.equal(presence.clientCount, 1);

  presence.release(second);
  await delay(15);
  presence.heartbeat(reopened);
  await delay(45);
  assert.equal(stops, 0);

  presence.release(reopened);
  await delay(55);
  assert.equal(stops, 1);
  presence.dispose();
});

test('renews an active background tab and expires crashed tabs after their lease', async () => {
  let stops = 0;
  const presence = createClientPresence({ onEmpty: () => { stops += 1; }, leaseMs: 45, shutdownGraceMs: 20, startupGraceMs: 500 });
  const tab = '4b4e28ba-2fa1-11d2-883f-0016d3cca427';
  presence.heartbeat(tab);
  await delay(30);
  presence.heartbeat(tab);
  await delay(30);
  assert.equal(stops, 0);
  await delay(100);
  assert.equal(stops, 1);
  presence.dispose();
});

test('restarts the client lease after a suspended process resumes with a delayed timer', () => {
  let now = 0;
  let stops = 0;
  const timers = [];
  const schedule = (callback, delayMs) => {
    const timer = { callback, due: now + delayMs, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const cancel = (timer) => { timer.cancelled = true; };
  const nextTimer = () => {
    const timer = timers.find((candidate) => !candidate.cancelled);
    assert.ok(timer, 'expected a scheduled presence timer');
    timer.cancelled = true;
    return timer;
  };
  const presence = createClientPresence({
    onEmpty: () => { stops += 1; },
    leaseMs: 100,
    shutdownGraceMs: 20,
    startupGraceMs: 500,
    maxTimerDriftMs: 10,
    now: () => now,
    schedule,
    cancel,
  });
  const tab = '5b4e28ba-2fa1-11d2-883f-0016d3cca427';

  presence.heartbeat(tab);
  const expiry = nextTimer();
  now = 10_000;
  expiry.callback();
  assert.equal(stops, 0);
  assert.equal(presence.clientCount, 1);

  const renewedExpiry = nextTimer();
  assert.equal(renewedExpiry.due, now + 101);
  now = renewedExpiry.due;
  renewedExpiry.callback();
  assert.equal(stops, 0);

  const shutdown = nextTimer();
  now = shutdown.due;
  shutdown.callback();
  assert.equal(stops, 1);
  presence.dispose();
});

test('stops an idle packaged server if the browser never opens', async () => {
  let stops = 0;
  const presence = createClientPresence({ onEmpty: () => { stops += 1; }, leaseMs: 100, shutdownGraceMs: 10, startupGraceMs: 20 });
  await delay(35);
  assert.equal(stops, 1);
  presence.dispose();
});
