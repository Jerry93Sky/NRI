import { describe, expect, it, vi } from 'vitest';
import { createUploadAdmission } from './uploadAdmission.js';

describe('asset upload admission', () => {
  it('grants queued work in order and refuses a full queue', async () => {
    const gate = createUploadAdmission(1, 2);
    const signal = new AbortController().signal;
    const first = await gate.acquire(signal);
    const waiting = gate.acquire(signal);
    const next = gate.acquire(signal);
    expect(await gate.acquire(signal)).toBeUndefined();
    expect(gate.stats()).toEqual({ active: 1, queued: 2, peakActive: 1 });
    first!();
    const second = await waiting;
    first!();
    expect(gate.stats()).toEqual({ active: 1, queued: 1, peakActive: 1 });
    second!();
    (await next)!();
    expect(gate.stats()).toEqual({ active: 0, queued: 0, peakActive: 1 });
  });

  it('removes disconnected and timed out waiters without using an active slot', async () => {
    vi.useFakeTimers();
    try {
      const gate = createUploadAdmission(1, 2, 50);
      const abort = new AbortController();
      const signal = new AbortController().signal;
      const release = await gate.acquire(signal);
      const cancelled = gate.acquire(abort.signal);
      const timedOut = gate.acquire(signal);
      abort.abort();
      expect(await cancelled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(50);
      expect(await timedOut).toBeUndefined();
      release!();
      expect(gate.stats()).toEqual({ active: 0, queued: 0, peakActive: 1 });
    } finally { vi.useRealTimers(); }
  });
});
