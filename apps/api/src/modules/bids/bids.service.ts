import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { Db } from '../../common/db';
import { Clock } from '../../common/clock';
import { AppError, fail } from '../../common/errors';
import { Audit } from '../../common/audit';
import { commitmentOf, sealBid } from '../../adapters/kms';
import { openText, sealText } from '../../common/seal';
import { AuthService, User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { EligibilityService } from '../lots/eligibility.service';
import { RiskService } from '../risk/risk.service';
import { fmtAmd, fmtYerevan } from '../../common/format';
import { rateLimit } from '../../common/ratelimit';
import { SettingsService } from '../../common/settings';

export interface BidReceipt {
  bidId: string;
  lotId: number;
  receiptNo: string;
  amount: number;
  serverReceivedAt: string;
  commitment: string;
  /** PRD v2 решение 9: номер версии (1 = первая ставка) и сколько изменений осталось */
  version: number;
  changesLeft: number;
}

const MAX_BID = 1_000_000_000_000; // защитный предел (1 трлн ֏)

/** SC-08…SC-10, 7.4: одна закрытая ставка на участника; PRD v2 — до N изменений, в зачёт последняя версия. */
@Injectable()
export class BidsService {
  constructor(
    private db: Db,
    private clock: Clock,
    private audit: Audit,
    private auth: AuthService,
    private notify: NotifyService,
    private elig: EligibilityService,
    private risk: RiskService,
    private settings: SettingsService,
  ) {}

  private async maxChanges(t?: any): Promise<number> {
    return Number((await this.settings.all(t)).bid_max_changes ?? 3);
  }

  /** R-04: целое число драмов строго больше начальной цены, без шага и округления. */
  static parseAmount(raw: unknown): number {
    const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.replace(/[\s ]/g, '') : '';
    if (!/^\d+$/.test(s)) throw new AppError('BID_NOT_INTEGER');
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n > MAX_BID) throw new AppError('BID_NOT_INTEGER');
    return n;
  }

  private async receiptByKey(user: User, lotId: number, key: string): Promise<BidReceipt | null> {
    const v = await this.db.maybe(
      `SELECT v.*, b.lot_id, b.user_id FROM bid_versions v JOIN bids b ON b.id=v.bid_id WHERE v.idempotency_key=$1`,
      [key],
    );
    if (!v) return null;
    if (v.user_id !== user.id || v.lot_id !== lotId) fail('IDEMPOTENCY_KEY_REUSED', 409);
    return this.toReceipt({ ...v, id: v.bid_id }, await this.maxChanges());
  }
  /** b — строка bids (текущая версия) или bid_versions с id = bid_id */
  private toReceipt(b: any, maxChanges: number): BidReceipt {
    const { amount } = JSON.parse(openText(b.owner_ciphertext, 'bid:' + b.id));
    const version = Number(b.version ?? 1);
    return {
      bidId: b.id, lotId: b.lot_id, receiptNo: b.receipt_no, amount, serverReceivedAt: new Date(b.server_received_at).toISOString(), commitment: b.commitment,
      version, changesLeft: Math.max(0, maxChanges - (version - 1)),
    };
  }

  async place(user: User, lotId: number, body: { amount: unknown; idempotencyKey?: string; acceptRules?: boolean }, stepUp: string | undefined, fp: { ua: string; ip: string }) {
    // Время приёма фиксируется сразу: ставка принята, если сервер получил её строго до времени конца (R-03)
    const receivedAt = this.clock.now();
    rateLimit('bid-ip:' + fp.ip, 30, 60_000);
    rateLimit('bid-user:' + user.id, 10, 60_000);
    const key = String(body.idempotencyKey || '').slice(0, 100);
    if (key.length < 8) fail('IDEMPOTENCY_KEY_REQUIRED');
    // Повторное нажатие с тем же ключом не создаёт вторую ставку — возвращаем ту же квитанцию
    const replay = await this.receiptByKey(user, lotId, key);
    if (replay) return replay;

    let receipt: BidReceipt;
    try {
      receipt = await this.db.tx(async (t) => {
        const lot = await t.maybe(`SELECT * FROM lots WHERE id=$1 FOR SHARE`, [lotId]);
        if (!lot) fail('LOT_NOT_FOUND', 404);
        if (receivedAt.getTime() >= new Date(lot.closes_at).getTime() || !['scheduled', 'live'].includes(lot.status)) {
          if (['scheduled', 'live', 'revealing', 'finished', 'no_sale', 'sold'].includes(lot.status) && lot.closes_at && receivedAt.getTime() >= new Date(lot.closes_at).getTime()) fail('AUCTION_ENDED', 409); // SC-10
          fail('AUCTION_NOT_OPEN', 409);
        }
        if (receivedAt.getTime() < new Date(lot.opens_at).getTime()) fail('AUCTION_NOT_STARTED', 409);
        if (lot.seller_id === user.id) fail('OWN_LOT', 403);
        const amount = BidsService.parseAmount(body.amount);
        if (amount <= lot.start_price) fail('BID_TOO_LOW', 400, { min: lot.start_price + 1 });
        const existing = await t.maybe('SELECT id FROM bids WHERE lot_id=$1 AND user_id=$2', [lotId, user.id]);
        if (existing) fail('BID_EXISTS', 409); // SC-09
        const sub = await this.elig.assertCanParticipate(user, lot, t, { needDeposit: true });
        // правила торгов — согласие при первой ставке (AU-08)
        const missing = await this.auth.missingConsents(user.id, ['auction_rules']);
        if (missing.length) {
          if (!body.acceptRules) fail('CONSENT_REQUIRED', 403, { missing });
          await this.auth.accept(user.id, ['auction_rules'], t);
        }
        await this.auth.consumeStepUp(user, 'bid', stepUp, t);

        const bidId = crypto.randomUUID();
        const salt = crypto.randomBytes(16).toString('hex');
        // 7.4.2: сумма сразу шифруется открытым ключом лота; открытой суммы нет нигде
        const ciphertext = sealBid(lot.public_key, { amount, salt });
        const commitment = commitmentOf(amount, salt, bidId);
        const ownerCipher = sealText(JSON.stringify({ amount }), 'bid:' + bidId);
        const receiptNo = `${lotId}-${receivedAt.getTime().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        await t.q(
          `INSERT INTO bids(id, lot_id, user_id, subscription_id, ciphertext, commitment, idempotency_key, receipt_no, server_received_at, owner_ciphertext)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [bidId, lotId, user.id, sub.id, ciphertext, commitment, key, receiptNo, receivedAt, ownerCipher],
        );
        await t.q(
          `INSERT INTO bid_versions(bid_id, version, ciphertext, commitment, owner_ciphertext, receipt_no, idempotency_key, server_received_at)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7)`,
          [bidId, ciphertext, commitment, ownerCipher, receiptNo, key, receivedAt],
        );
        // в журнал — без суммы (7.4.4)
        await this.audit.log(user.id, 'bid.placed', 'bid', bidId, null, { lotId, receiptNo, commitment }, t);
        const r: BidReceipt = { bidId, lotId, receiptNo, amount, serverReceivedAt: receivedAt.toISOString(), commitment, version: 1, changesLeft: await this.maxChanges(t) };
        await this.notify.queue(
          user.id,
          'email',
          'bid_receipt',
          { lotId, receiptNo, amount: fmtAmd(amount), receivedAt: fmtYerevan(receivedAt, true), commitment },
          { sealed: true, dedupeKey: 'receipt:' + bidId },
          t,
        );
        return r;
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        // гонка: два запроса одновременно — в базе остаётся только первая ставка
        const again = await this.receiptByKey(user, lotId, key);
        if (again) return again;
        fail('BID_EXISTS', 409);
      }
      throw e;
    }
    await this.risk.recordFingerprint(user.id, fp.ua, fp.ip);
    return receipt!;
  }

  /**
   * PRD v2 решение 9: изменить свою ставку (повысить или понизить) до конца торгов.
   * Строка bids перезаписывается новой версией — по ней идёт вскрытие; при равных суммах
   * учитывается время ПОСЛЕДНЕЙ версии. Депозит и попытка тарифа повторно не берутся.
   */
  async change(user: User, lotId: number, body: { amount: unknown; idempotencyKey?: string }, stepUp: string | undefined, fp: { ua: string; ip: string }) {
    const receivedAt = this.clock.now();
    rateLimit('bid-ip:' + fp.ip, 30, 60_000);
    rateLimit('bid-user:' + user.id, 10, 60_000);
    const key = String(body.idempotencyKey || '').slice(0, 100);
    if (key.length < 8) fail('IDEMPOTENCY_KEY_REQUIRED');
    const replay = await this.receiptByKey(user, lotId, key);
    if (replay) return replay;
    let receipt: BidReceipt;
    try {
      receipt = await this.db.tx(async (t) => {
        const lot = await t.maybe(`SELECT * FROM lots WHERE id=$1 FOR SHARE`, [lotId]);
        if (!lot) fail('LOT_NOT_FOUND', 404);
        if (lot.closes_at && receivedAt.getTime() >= new Date(lot.closes_at).getTime()) fail('AUCTION_ENDED', 409);
        if (!['scheduled', 'live'].includes(lot.status)) fail('AUCTION_NOT_OPEN', 409);
        const bid = await t.maybe(`SELECT * FROM bids WHERE lot_id=$1 AND user_id=$2 FOR UPDATE`, [lotId, user.id]);
        if (!bid) fail('BID_NOT_FOUND', 404);
        const max = await this.maxChanges(t);
        if (bid.version - 1 >= max) fail('BID_CHANGES_EXHAUSTED', 409, { max });
        const amount = BidsService.parseAmount(body.amount);
        if (amount <= lot.start_price) fail('BID_TOO_LOW', 400, { min: lot.start_price + 1 });
        await this.auth.consumeStepUp(user, 'bid', stepUp, t);

        const version = bid.version + 1;
        const salt = crypto.randomBytes(16).toString('hex');
        const ciphertext = sealBid(lot.public_key, { amount, salt });
        const commitment = commitmentOf(amount, salt, bid.id);
        const ownerCipher = sealText(JSON.stringify({ amount }), 'bid:' + bid.id);
        const receiptNo = `${lotId}-${receivedAt.getTime().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}-V${version}`;
        await t.q(
          `INSERT INTO bid_versions(bid_id, version, ciphertext, commitment, owner_ciphertext, receipt_no, idempotency_key, server_received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [bid.id, version, ciphertext, commitment, ownerCipher, receiptNo, key, receivedAt],
        );
        await t.q(
          `UPDATE bids SET version=$2, ciphertext=$3, commitment=$4, owner_ciphertext=$5, receipt_no=$6, server_received_at=$7 WHERE id=$1`,
          [bid.id, version, ciphertext, commitment, ownerCipher, receiptNo, receivedAt],
        );
        // в журнал — без суммы (7.4.4)
        await this.audit.log(user.id, 'bid.changed', 'bid', bid.id, null, { lotId, receiptNo, commitment, version }, t);
        await this.notify.queue(
          user.id,
          'email',
          'bid_receipt',
          { lotId, receiptNo, amount: fmtAmd(amount), receivedAt: fmtYerevan(receivedAt, true), commitment },
          { sealed: true, dedupeKey: 'receipt:' + bid.id + ':' + version },
          t,
        );
        return { bidId: bid.id, lotId, receiptNo, amount, serverReceivedAt: receivedAt.toISOString(), commitment, version, changesLeft: Math.max(0, max - (version - 1)) };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        // гонка двух изменений: вторая версия с тем же номером не сохраняется
        const again = await this.receiptByKey(user, lotId, key);
        if (again) return again;
        fail('BID_CHANGE_CONFLICT', 409);
      }
      throw e;
    }
    await this.risk.recordFingerprint(user.id, fp.ua, fp.ip);
    return receipt!;
  }

  async mine(user: User, lotId: number) {
    const b = await this.db.maybe(`SELECT * FROM bids WHERE lot_id=$1 AND user_id=$2`, [lotId, user.id]);
    if (!b) return null;
    const max = await this.maxChanges();
    const vs = await this.db.q(`SELECT * FROM bid_versions WHERE bid_id=$1 ORDER BY version DESC`, [b.id]);
    // история версий видна только самому участнику (суммы расшифровываются ключом сервера)
    const versions = vs.map((v: any) => ({ ...this.toReceipt({ ...v, id: b.id, lot_id: b.lot_id }, max), current: v.version === b.version }));
    return { ...this.toReceipt(b, max), versions };
  }

  /** «Мои ставки» — активные и завершённые. */
  async allMine(user: User) {
    const rows = await this.db.q(
      `SELECT b.*, l.status AS lot_status, l.closes_at, l.start_price, p.property_type, p.settlement, p.street, r.winner_user_id
       FROM bids b JOIN lots l ON l.id=b.lot_id JOIN properties p ON p.id=l.property_id LEFT JOIN lot_results r ON r.lot_id=l.id
       WHERE b.user_id=$1 ORDER BY b.server_received_at DESC`,
      [user.id],
    );
    const max = await this.maxChanges();
    return rows.map((b) => ({
      ...this.toReceipt(b, max),
      lotStatus: b.lot_status,
      closesAt: b.closes_at,
      startPrice: b.start_price,
      property: { type: b.property_type, settlement: b.settlement, street: b.street },
      won: b.winner_user_id === user.id,
    }));
  }
}
