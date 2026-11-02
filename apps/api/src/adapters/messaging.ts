import { Injectable } from '@nestjs/common';

/** SMS и email — каждый за своим интерфейсом (7.1). В разработке — фейки: письма видны в /dev/outbox. */
export interface SmsAdapter {
  send(phone: string, text: string): Promise<void>;
}
export interface EmailAdapter {
  send(to: string, subject: string, body: string): Promise<void>;
}

@Injectable()
export class FakeSms implements SmsAdapter {
  async send(phone: string, text: string) {
    if (process.env.NODE_ENV !== 'test' && process.env.LOG_SMS !== 'false') console.log(`[sms → ${phone}] ${text}`);
  }
}

@Injectable()
export class FakeEmail implements EmailAdapter {
  /** Адреса с «+fail» имитируют ошибку отправки — чтобы проверить повторы (SC-12). */
  async send(to: string, subject: string, _body: string) {
    if (to.includes('+fail')) throw new Error('SMTP 550 mailbox unavailable');
    if (process.env.NODE_ENV !== 'test' && process.env.LOG_EMAIL !== 'false') console.log(`[email → ${to}] ${subject}`);
  }
}
