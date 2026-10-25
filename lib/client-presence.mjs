const CLIENT_ID = /^[0-9a-f-]{36}$/i;

export function validClientId(value) {
  return typeof value === 'string' && CLIENT_ID.test(value);
}

export function createClientPresence({
  onEmpty,
  leaseMs = 5 * 60 * 1000,
  shutdownGraceMs = 20 * 1000,
  startupGraceMs = 90 * 1000,
  maxTimerDriftMs = 60 * 1000,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  if (typeof onEmpty !== 'function') throw new TypeError('onEmpty callback is required.');
  if (![leaseMs, shutdownGraceMs, startupGraceMs, maxTimerDriftMs].every((value) => Number.isFinite(value) && value >= 0)) throw new RangeError('Presence delays must be non-negative numbers.');

  const clients = new Map();
  let timer = null;
  let stopped = false;
  let seenClient = false;

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function pruneExpired() {
    const threshold = now() - leaseMs;
    for (const [id, lastSeen] of clients) if (lastSeen <= threshold) clients.delete(id);
  }

  function scheduleNext() {
    if (stopped) return;
    clearTimer();
    pruneExpired();
    if (clients.size) {
      const oldest = Math.min(...clients.values());
      const delay = Math.max(1, oldest + leaseMs - now() + 1);
      const deadline = now() + delay;
      timer = schedule(() => {
        timer = null;
        const resumedAt = now();
        if (resumedAt - deadline > maxTimerDriftMs) {
          for (const [id, lastSeen] of clients) {
            if (resumedAt - lastSeen > leaseMs) clients.set(id, resumedAt);
          }
        }
        scheduleNext();
      }, delay);
    } else {
      const delay = seenClient ? shutdownGraceMs : startupGraceMs;
      timer = schedule(() => {
        timer = null;
        pruneExpired();
        if (clients.size) { scheduleNext(); return; }
        stopped = true;
        Promise.resolve(onEmpty()).catch(() => {});
      }, delay);
    }
    timer?.unref?.();
  }

  function heartbeat(id) {
    if (stopped) return false;
    clients.set(id, now());
    seenClient = true;
    scheduleNext();
    return true;
  }

  function release(id) {
    if (stopped) return false;
    clients.delete(id);
    scheduleNext();
    return true;
  }

  function dispose() {
    stopped = true;
    clearTimer();
    clients.clear();
  }

  scheduleNext();
  return Object.freeze({ heartbeat, release, dispose, get clientCount() { pruneExpired(); return clients.size; } });
}
