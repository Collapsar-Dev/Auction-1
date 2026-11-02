import { AppError } from './errors';

/** AU-06: ограничение частоты запросов (в памяти процесса; в бою — Redis). */
const buckets = new Map<string, number[]>();
export function rateLimit(key: string, max: number, windowMs: number, now = Date.now()) {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMIT) return;
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new AppError('RATE_LIMITED', 429, { retryAfterSec: Math.ceil((windowMs - (now - arr[0])) / 1000) });
  arr.push(now);
  buckets.set(key, arr);
}
export function resetRateLimits() {
  buckets.clear();
}
