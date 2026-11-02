'use client';

export class ApiError extends Error {
  constructor(public code: string, public status: number, public data: any) {
    super(code);
  }
}

let refreshing: Promise<boolean> | null = null;
async function refresh() {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => setTimeout(() => (refreshing = null), 0));
  }
  return refreshing;
}

/** Обёртка над fetch: JSON, ошибки с кодом, автоматическое обновление сессии (AU-02). */
export async function api<T = any>(path: string, opts: { method?: string; body?: any; headers?: Record<string, string>; form?: FormData; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, credentials: 'include', cache: 'no-store' });
  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/')) {
    if (await refresh()) return api(path, { ...opts, retry: false });
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'HTTP_' + res.status };
  }
  if (!res.ok) throw new ApiError(data?.error || 'HTTP_' + res.status, res.status, data || {});
  return data as T;
}

export const newIdempotencyKey = () => (crypto as any).randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
