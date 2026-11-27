export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, credentials: 'include', headers });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error ?? 'REQUEST_FAILED');
  return result as T;
}
