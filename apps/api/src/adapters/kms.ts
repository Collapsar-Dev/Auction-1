import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { AppError } from '../common/errors';

/**
 * Фейковый KMS (7.4.1). Закрытый ключ лота хранится только «обёрнутым» мастер-ключом.
 * Развернуть его можно только после notBefore (= closes_at) — это проверяет сам KMS,
 * как политика ключа в настоящем управляемом хранилище.
 */
export interface KmsAdapter {
  wrap(lotId: number, plaintext: string): string;
  unwrap(lotId: number, wrapped: string, notBefore: Date, now: Date): string;
}

@Injectable()
export class FakeKms implements KmsAdapter {
  private key = crypto.createHash('sha256').update(process.env.KMS_MASTER_KEY || 'dev-kms-master-key').digest();
  wrap(lotId: number, plaintext: string) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from('lot:' + lotId));
    const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  }
  unwrap(lotId: number, wrapped: string, notBefore: Date, now: Date) {
    if (now.getTime() < notBefore.getTime()) throw new AppError('KMS_POLICY_DENIED', 403);
    const [iv, tag, enc] = wrapped.split('.').map((p) => Buffer.from(p, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(Buffer.from('lot:' + lotId));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }
}

/** Пара ключей лота: RSA-OAEP. Сумма шифруется открытым ключом сразу при приёме ставки. */
export function generateLotKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}
export function sealBid(publicKey: string, payload: { amount: number; salt: string }) {
  return crypto
    .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(JSON.stringify(payload)))
    .toString('base64');
}
export function openBid(privateKey: string, ciphertext: string): { amount: number; salt: string } {
  const buf = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(ciphertext, 'base64'));
  return JSON.parse(buf.toString('utf8'));
}
/** 7.4.3: контрольный код = SHA-256(сумма + соль + id ставки). */
export function commitmentOf(amount: number, salt: string, bidId: string) {
  return crypto.createHash('sha256').update(`${amount}${salt}${bidId}`).digest('hex');
}
