type ApiOptions = RequestInit & { recoverable?: boolean | 'scene' };
const campaignRequests = new Map<string, string>();
const sceneRequests = new Map<string, string>();

export function clearRecoverableRequests(scope?: 'scene') {
  sceneRequests.clear();
  if (!scope) campaignRequests.clear();
}

function intentFingerprint(path: string, options: RequestInit): string {
  const method = (options.method ?? 'GET').toUpperCase();
  const body = options.body instanceof FormData
    ? [...options.body.entries()].map(([key, value]) => value instanceof File
      ? [key, value.name, value.size, value.type, value.lastModified]
      : [key, value])
    : typeof options.body === 'string' ? options.body : '';
  return `${method}:${path}:${JSON.stringify(body)}`;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { recoverable = false, ...requestOptions } = options;
  const pendingRequestIds = recoverable === 'scene' ? sceneRequests : campaignRequests;
  const headers = new Headers(requestOptions.headers);
  const fingerprint = recoverable ? intentFingerprint(path, requestOptions) : null;
  if (fingerprint) {
    const requestId = pendingRequestIds.get(fingerprint) ?? crypto.randomUUID();
    pendingRequestIds.set(fingerprint, requestId);
    headers.set('idempotency-key', requestId);
  }
  if (requestOptions.body !== undefined && !(requestOptions.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let responseReceived = false;
  try {
    const response = await fetch(path, { ...requestOptions, credentials: 'include', headers });
    responseReceived = true;
    let result: any = null;
    try { result = response.status === 204 ? null : await response.json(); }
    catch { if (fingerprint) throw new Error('OUTCOME_UNKNOWN'); throw new Error('INVALID_RESPONSE'); }
    if (!response.ok) {
      if (fingerprint && response.status >= 500) throw new Error('OUTCOME_UNKNOWN');
      if (fingerprint && pendingRequestIds.get(fingerprint) === headers.get('idempotency-key')) pendingRequestIds.delete(fingerprint);
      throw new Error(result?.error ?? 'REQUEST_FAILED');
    }
    // A 207 upload has committed some files. Keep the batch key for an explicit retry.
    if (response.status !== 207 && fingerprint && pendingRequestIds.get(fingerprint) === headers.get('idempotency-key')) pendingRequestIds.delete(fingerprint);
    if (path.startsWith('/api/auth/') && requestOptions.method === 'POST') clearRecoverableRequests();
    return result as T;
  } catch (error) {
    if (fingerprint && (!responseReceived || (error instanceof Error && error.message === 'OUTCOME_UNKNOWN'))) {
      // The request stays pending only if its scope has not been cleared in the meantime.
      throw new Error('OUTCOME_UNKNOWN');
    }
    throw error;
  }
}
