const clientId = crypto.randomUUID();

function sendPresence(active, keepalive = false) {
  const body = JSON.stringify({ clientId, active });
  if (!active && keepalive && navigator.sendBeacon) {
    const queued = navigator.sendBeacon('/api/system/presence', new Blob([body], { type: 'application/json' }));
    if (queued) return;
  }
  fetch('/api/system/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    cache: 'no-store',
    keepalive,
  }).catch(() => {});
}

sendPresence(true);
const heartbeat = window.setInterval(() => sendPresence(true), 30_000);

window.addEventListener('pageshow', () => sendPresence(true));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) sendPresence(true);
});
window.addEventListener('pagehide', () => {
  window.clearInterval(heartbeat);
  sendPresence(false, true);
});
