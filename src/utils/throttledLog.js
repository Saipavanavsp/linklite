// When Redis goes down every request would log the same warning. This logs a
// given key at most once per interval and says how many were skipped.
function throttledLog(logFn = console.warn, intervalMs = 10_000, now = Date.now) {
  const last = new Map();

  return function log(key, message) {
    const entry = last.get(key);
    const time = now();
    if (entry && time - entry.at < intervalMs) {
      entry.skipped++;
      return;
    }
    const suffix = entry && entry.skipped ? ` (${entry.skipped} similar messages suppressed)` : '';
    last.set(key, { at: time, skipped: 0 });
    logFn(message + suffix);
  };
}

module.exports = throttledLog;
