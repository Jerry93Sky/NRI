type Release = () => void;
type Waiting = { grant: () => void };

/** Limits streams being buffered/decoded before they reach any write transaction. */
export function createUploadAdmission(concurrency = 2, queueLimit = 6, waitMs = 10_000) {
  let active = 0;
  let peakActive = 0;
  const queue: Waiting[] = [];
  function take(): Release {
    active++;
    peakActive = Math.max(peakActive, active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      queue.shift()?.grant();
    };
  }
  function acquire(signal: AbortSignal): Promise<Release | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (active < concurrency) return Promise.resolve(take());
    if (queue.length >= queueLimit) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const finish = (release?: Release) => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(release);
      };
      const cancel = () => finish();
      const waiter = { grant: () => finish(take()) };
      const timer = setTimeout(cancel, waitMs);
      timer.unref();
      queue.push(waiter);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  return { acquire, stats: () => ({ active, queued: queue.length, peakActive }) };
}
