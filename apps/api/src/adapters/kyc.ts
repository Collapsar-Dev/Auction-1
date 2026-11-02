import { Injectable } from '@nestjs/common';
import crypto from 'crypto';

/** Интерфейс KYC-сервиса (SC-02). Фейк: страница-песочница, где тестировщик выбирает ответ. */
export interface KycResult {
  sessionId: string;
  decision: 'approved' | 'rejected' | 'manual';
  fullName?: string;
  birthDate?: string; // YYYY-MM-DD
  docNumber?: string;
  reason?: string;
}
export interface KycAdapter {
  createSession(userId: number): Promise<{ sessionId: string; url: string }>;
}
@Injectable()
export class FakeKyc implements KycAdapter {
  async createSession(userId: number) {
    const sessionId = 'kyc_' + userId + '_' + crypto.randomBytes(6).toString('hex');
    const web = process.env.WEB_URL || 'http://localhost:3000';
    return { sessionId, url: `${web}/sandbox/kyc?session=${sessionId}` };
  }
}
