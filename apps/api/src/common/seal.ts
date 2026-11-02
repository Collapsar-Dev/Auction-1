import crypto from 'crypto';
import { secret } from './hash';

/** Шифрование ключом сервера (не хранится в базе): доступ к базе не раскрывает сумму ставки. */
const key = () => crypto.createHash('sha256').update('seal:' + secret()).digest();
export function sealText(plain: string, aad: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function openText(sealed: string, aad: string) {
  const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
