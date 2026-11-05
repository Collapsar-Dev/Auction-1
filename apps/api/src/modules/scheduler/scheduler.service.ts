import { ChainService } from '../chain/chain.service';
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Db } from '../../common/db';
import { Clock, DAY, HOUR } from '../../common/clock';
import { SettingsService } from '../../common/settings';
import { Audit } from '../../common/audit';
import { FakeGateway } from '../../adapters/gateway';
import { NotifyService } from '../notifications/notify.service';
import { RevealService } from '../reveal/reveal.service';
import { DealsService } from '../deals/deals.service';
import { DepositsService } from '../deposits/deposits.service';
import { fmtYerevan } from '../../common/format';

/**
 * Фоновые задачи (7.5). В этой версии — один процесс с циклом-сторожем (по умолчанию каждые 2 с)
 * вместо Redis + BullMQ; все задачи идемпотентны (дедуп-ключи, блокировки строк), поэтому
 * их можно безопасно перенести в BullMQ без изменения логики (ADR-001).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRun = new Map<string, number>();

  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private gw: FakeGateway,
    private notify: NotifyService,
    private reveal: RevealService,
    private deals: DealsService,
    private deposits: DepositsService,
   private chain: ChainService,
  ) {}

  async onApplicationBootstrap() {
    // фейковый банк живёт в памяти/файле: восстанавливаем привязки карт из базы
    const cards = await this.db.q<{ binding_id: string; mask: string }>(`SELECT binding_id, mask FROM cards WHERE status='active'`).catch(() => []);
    for (const c of cards) this.gw.restoreBinding(c.binding_id, c.mask);
    if (process.env.NODE_ENV === 'test' || process.env.SCHEDULER === 'off') return;
    await this.detectOutage().catch((e) => console.error('[outage]', e.message));
    const every = Number(process.env.SCHEDULER_INTERVAL_MS || 2000);
    this.timer = setInterval(() => void this.tick(), every);
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private due(name: string, everyMs: number) {
    const now = this.clock.ms();
    if (now - (this.lastRun.get(name) ?? 0) < everyMs) return false;
    this.lastRun.set(name, now);
    return true;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.db.q(`INSERT INTO heartbeats(id, at) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET at=EXCLUDED.at`, [this.clock.now()]);
      await this.openLots();
      await this.reveal.revealDue();
      if (this.due('watchdog', 60_000)) await this.reveal.watchdog();
      await this.endingReminders();
      await this.deals.tick();
      await this.deposits.processReleases();
      if (this.due('renew', HOUR)) await this.deposits.renewHolds();
      if (this.due('subs', HOUR)) await this.subscriptionReminders();
      if (this.due('reconcile', DAY)) await this.reconcile();
      await this.notify.deliver();
      await this.chain.seal(); // PRD v2: хэш-цепочки журнала и счетов
    } catch (e: any) {
      console.error('[scheduler]', e?.message);
    } finally {
      this.running = false;
    }
  }

  /** «Скоро» → «Идёт» в opens_at; подписчикам избранного — «лот начался». */
  async openLots() {
    const rows = await this.db.q<{ id: number; closes_at: Date; settlement: string; street: string }>(
      `UPDATE lots l SET status='live' FROM properties p WHERE p.id=l.property_id AND l.status='scheduled' AND l.opens_at <= $1 AND l.closes_at > $1 RETURNING l.id, l.closes_at, p.settlement, p.street`,
      [this.clock.now()],
    );
    for (const l of rows) {
      const favs = await this.db.q<{ user_id: number }>('SELECT user_id FROM favorites WHERE lot_id=$1', [l.id]);
      for (const f of favs) await this.notify.queue(f.user_id, 'email', 'favorite_started', { lotId: l.id, title: `${l.settlement}, ${l.street}`, closesAt: fmtYerevan(l.closes_at) }, { dedupeKey: `fav_start:${l.id}:${f.user_id}` });
    }
    return rows.length;
  }

  /** За 24 ч и за 1 ч — тем, кто внёс депозит, но ещё не поставил, и подписавшимся (избранное). */
  async endingReminders() {
    const now = this.clock.ms();
    for (const [k, h, left] of [
      ['24h', 24, '24 ч'],
      ['1h', 1, '1 ч'],
    ] as const) {
      const lots = await this.db.q<{ id: number; closes_at: Date; settlement: string; street: string }>(
        `SELECT l.id, l.closes_at, p.settlement, p.street FROM lots l JOIN properties p ON p.id=l.property_id WHERE l.status='live' AND l.closes_at > $1 AND l.closes_at <= $2`,
        [new Date(now), new Date(now + h * HOUR)],
      );
      for (const l of lots) {
        const users = await this.db.q<{ user_id: number }>(
          `SELECT user_id FROM deposits WHERE lot_id=$1 AND status='held' UNION SELECT user_id FROM favorites WHERE lot_id=$1
           EXCEPT SELECT user_id FROM bids WHERE lot_id=$1`,
          [l.id],
        );
        for (const u of users) {
          await this.notify.queue(u.user_id, 'email', 'ending_soon', { lotId: l.id, title: `${l.settlement}, ${l.street}`, closesAt: fmtYerevan(l.closes_at), left }, { dedupeKey: `ending:${l.id}:${u.user_id}:${k}` });
        }
      }
    }
  }

  /** Годовой доступ: напоминания за 14 и 3 дня; статус «Инвестор» — за 14 дней. Удаление документов о средствах. */
  async subscriptionReminders() {
    const days = (await this.settings.get('subscription_reminder_days')) as number[];
    const now = this.clock.ms();
    for (const d of days) {
      const subs = await this.db.q(
        `SELECT s.id, s.user_id, s.ends_at, p.name_i18n FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status='active' AND s.ends_at > $1 AND s.ends_at <= $2
         AND NOT EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.user_id=s.user_id AND s2.status='active' AND s2.ends_at > s.ends_at)`,
        [new Date(now), new Date(now + d * DAY)],
      );
      for (const s of subs) await this.notify.queue(s.user_id, 'email', 'subscription_expiring', { plan: s.name_i18n.ru, endsAt: fmtYerevan(s.ends_at) }, { dedupeKey: `sub_exp:${s.id}:${d}` });
    }
    const inv = await this.db.q(`SELECT user_id, valid_until FROM buyer_limits WHERE tier='investor' AND valid_until > $1 AND valid_until <= $2`, [new Date(now), new Date(now + 14 * DAY)]);
    for (const i of inv) await this.notify.queue(i.user_id, 'email', 'investor_expiring', { validUntil: fmtYerevan(i.valid_until) }, { dedupeKey: `inv_exp:${i.user_id}:${new Date(i.valid_until).toISOString().slice(0, 10)}` });
    await this.db.q(`UPDATE funds_proofs SET storage_key='deleted' WHERE delete_after < $1 AND storage_key<>'deleted'`, [new Date(now)]);
  }

  /** Ежедневная сверка наших записей с шлюзом — расхождения сразу администратору (6.6). */
  async reconcile() {
    const held = await this.db.q<{ id: number; gateway_order_id: string }>(`SELECT id, gateway_order_id FROM deposits WHERE status IN ('held','disputed')`);
    const bad: number[] = [];
    for (const d of held) {
      const o = await this.gw.getOrderStatus(d.gateway_order_id);
      if (!o || o.status !== 'approved') bad.push(d.id);
    }
    if (bad.length) await this.notify.alarmAdmins('Gateway reconciliation mismatch', `Deposits: ${bad.join(', ')}`, `reconcile:${this.clock.now().toISOString().slice(0, 10)}`);
    return bad;
  }

  /** SC-18: при старте сравниваем последний «пульс» с текущим временем. Простой > 5 мин в последний час лота → сбой. */
  async detectOutage() {
    const hb = await this.db.maybe<{ at: Date }>('SELECT at FROM heartbeats WHERE id=1');
    if (!hb) return null;
    const s = await this.settings.all();
    const start = new Date(hb.at);
    const end = this.clock.now();
    if (end.getTime() - start.getTime() < s.outage_threshold_min * 60_000) return null;
    return this.recordOutage(start, end, null);
  }

  async recordOutage(start: Date, end: Date, actorId: number | null) {
    const lots = await this.db.q<{ id: number }>(
      `SELECT id FROM lots WHERE status IN ('scheduled','live') AND closes_at > $1 AND closes_at - interval '1 hour' < $2`,
      [start, end],
    );
    const ids = lots.map((l) => l.id);
    const o = await this.db.one(`INSERT INTO outages(started_at, ended_at, status, lot_ids, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
      start,
      end,
      ids.length ? 'detected' : 'dismissed',
      JSON.stringify(ids),
      this.clock.now(),
    ]);
    await this.audit.log(actorId, 'outage.detected', 'outage', o.id, null, { start, end, lots: ids });
    if (ids.length) await this.notify.alarmAdmins('Outage in the last hour of lots', `Outage ${start.toISOString()} – ${end.toISOString()}, lots: ${ids.join(', ')}. Confirm extension in admin.`, `outage:${o.id}`);
    return o;
  }
}
