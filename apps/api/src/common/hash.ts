import crypto from 'crypto';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (key: string, s: string) => crypto.createHmac('sha256', key).update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomDigits = (n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10).toString();
  return s;
};
export const secret = () => process.env.APP_SECRET || 'dev-secret-change-me';
/** Хэш кода/токена с секретом сервера — в базе хранится только он (AU-01). */
export const codeHash = (s: string) => hmac(secret(), s);
