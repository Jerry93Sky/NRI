import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, clearRecoverableRequests } from './api';

afterEach(() => {
  clearRecoverableRequests();
  vi.unstubAllGlobals();
});

describe('recoverable REST requests', () => {
  it('keeps the same in-memory key after a lost response, then starts a new key after success', async () => {
    const ids: string[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      ids.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      calls += 1;
      if (calls === 1) throw new TypeError('connection lost');
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    const options = { method: 'POST', body: JSON.stringify({ title: 'same intent' }), recoverable: true } as const;

    await expect(api('/api/campaigns', options)).rejects.toThrow('OUTCOME_UNKNOWN');
    await expect(api('/api/campaigns', options)).resolves.toEqual({ ok: true });
    await expect(api('/api/campaigns', options)).resolves.toEqual({ ok: true });
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('preserves campaign-level requests on scene changes and discards pending scene keys', async () => {
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      ids.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      throw new TypeError('connection lost');
    }));
    const scene = () => api('/api/tokens', { method: 'POST', recoverable: 'scene' });
    const campaign = () => api('/api/scenes', { method: 'POST', recoverable: true });
    await expect(scene()).rejects.toThrow('OUTCOME_UNKNOWN');
    await expect(campaign()).rejects.toThrow('OUTCOME_UNKNOWN');
    clearRecoverableRequests('scene');
    await expect(scene()).rejects.toThrow('OUTCOME_UNKNOWN');
    await expect(campaign()).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).toBe(ids[1]);
  });

  it('keeps the key on a server error and reports an unknown outcome', async () => {
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      ids.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), { status: 500 });
    }));
    const submit = () => api('/api/scenes', { method: 'POST', recoverable: true });
    await expect(submit()).rejects.toThrow('OUTCOME_UNKNOWN');
    await expect(submit()).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(ids[1]).toBe(ids[0]);
  });

  it('keeps a partially successful batch key until the same upload completes', async () => {
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      ids.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      return new Response(JSON.stringify({ assets: [{ id: 'original' }] }), { status: ids.length === 1 ? 207 : 201 });
    }));
    const body = new FormData();
    body.append('file', new File(['file'], 'fixture.png', { lastModified: 1, type: 'image/png' }));
    const submit = () => api('/api/campaigns/campaign/assets', { method: 'POST', body, recoverable: true });
    await submit();
    await submit();
    await submit();
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});
