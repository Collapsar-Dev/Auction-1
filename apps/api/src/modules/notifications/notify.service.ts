import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../../common/db';
import { Clock, HOUR } from '../../common/clock';
import { FakeEmail, FakeSms } from '../../adapters/messaging';
import { render } from './templates';
import { Lang } from '../../common/format';
import { openText, sealText } from '../../common/seal';

export interface QueueOpts {
  dedupeKey?: string;
  toAddr?: string; // явный адрес (например, ещё не подтверждённый email или номер для OTP)
  lang?: Lang;
  sealed?: boolean; // тело шифруется (содержит сумму собственной ставки до итога)
}

@Injectable()
export class NotifyService {
  constructor(private db: Db, private clock: Clock, private sms: FakeSms, private email: FakeEmail) {}

  /** Поставить уведомление в очередь. Возвращает false, если такое уже было (dedupe). */
  async queue(userId: number | null, channel: 'email' | 'sms', template: string, payload: Record<string, unknown>, opts: QueueOpts = {}, t: Queryable = this.db) {
    let lang: Lang = opts.lang ?? 'hy';
    let to = opts.toAddr ?? null;
    let status: 'queued' | 'failed' = 'queued';
    let err: string | null = null;
    if (userId) {
      const u = await t.maybe<{ lang: Lang; phone: string; email: string | null; email_verified_at: Date | null }>('SELECT lang, phone, email, email_verified_at FROM users WHERE id=$1', [userId]);
      if (u) {
        lang = opts.lang ?? u.lang;
        if (!to) to = channel === 'sms' ? u.phone : u.email_verified_at ? u.email : null;
      }
    }
    if (!to) {
      status = 'failed';
      err = channel === 'email' ? 'NO_VERIFIED_EMAIL' : 'NO_PHONE';
    }
    const { subject, body } = render(template, lang, payload);
    const storedBody = opts.sealed ? sealText(body, 'notification') : body;
    const storedPayload = opts.sealed ? {} : payload;
    const r = await t.q(
      `INSERT INTO notifications(user_id, channel, to_addr, template, lang, subject, body, payload, status, last_error, dedupe_key, sealed, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [userId, channel, to, template, lang, subject, storedBody, JSON.stringify(storedPayload), status, err, opts.dedupeKey ?? null, !!opts.sealed, this.clock.now()],
    );
    return r.length > 0;
  }

  /** Доставка очереди. Ошибки — повторы до 24 ч (SC-12), затем статус failed виден в админке. */
  async deliver(limit = 200) {
    const rows = await this.db.q<{ id: number; channel: string; to_addr: string; subject: string; body: string; created_at: Date; attempts: number; sealed: boolean }>(
      `SELECT id, channel, to_addr, subject, body, created_at, attempts, sealed FROM notifications WHERE status='queued' ORDER BY id LIMIT $1`,
      [limit],
    );
    for (const n of rows) {
      try {
        if (n.sealed) n.body = openText(n.body, 'notification');
        if (n.channel === 'sms') await this.sms.send(n.to_addr, n.body);
        else await this.email.send(n.to_addr, n.subject ?? '', n.body);
        await this.db.q(`UPDATE notifications SET status='sent', sent_at=$2, attempts=attempts+1 WHERE id=$1`, [n.id, this.clock.now()]);
      } catch (e: any) {
        const giveUp = this.clock.ms() - new Date(n.created_at).getTime() > 24 * HOUR;
        await this.db.q(`UPDATE notifications SET attempts=attempts+1, last_error=$2, status=$3 WHERE id=$1`, [n.id, String(e?.message ?? e), giveUp ? 'failed' : 'queued']);
      }
    }
    return rows.length;
  }

  /** Тревога всем администраторам (SC-11, 6.6). */
  async alarmAdmins(title: string, details: string, dedupeKey: string, t: Queryable = this.db) {
    const admins = await t.q<{ id: number }>(`SELECT id FROM users WHERE role='admin' AND status='active'`);
    for (const a of admins) await this.queue(a.id, 'email', 'admin_alarm', { title, details }, { dedupeKey: `${dedupeKey}:${a.id}`, lang: 'ru' }, t);
  }
}

/** Тело для показа владельцу (личный кабинет) или в dev-outbox. */
export const notificationBody = (n: { body: string; sealed: boolean }) => (n.sealed ? openText(n.body, 'notification') : n.body);
