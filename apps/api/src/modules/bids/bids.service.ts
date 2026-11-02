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

export interface BidReceipt {
  bidId: string;
  lotId: number;
  receiptNo: string;
  amount: number;
  serverReceivedAt: string;
  commitment: string;
}

const MAX_BID = 1_000_000_000_000; // защитный предел (1 трлн ֏)

/** SC-08…SC-10, 7.4: одна закрытая ставка на участника. */
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
  ) {}

  /** R-04: целое число драмов строго больше начальной цены, без шага и округления. */
  static parseAmount(raw: unknown): number {
    const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.replace(/[\s ]/g, '') : '';
    if (!/^\d+$/.test(s)) throw new AppError('BID_NOT_INTEGER');
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n > MAX_BID) throw new AppError('BID_NOT_INTEGER');
    return n;
  }

  private async receiptByKey(user: User, lotId: number, key: string): Promise<BidReceipt | null> {
    const b = await this.db.maybe(`SELECT * FROM bids WHERE idempotency_key=$1`, [key]);
    if (!b) return null;
    if (b.user_id !== user.id || b.lot_id !== lotId) fail('IDEMPOTENCY_KEY_REUSED', 409);
    return this.toReceipt(b);
  }
  private toReceipt(b: any): BidReceipt {
    const { amount } = JSON.parse(openText(b.owner_ciphertext, 'bid:' + b.id));
    return { bidId: b.id, lotId: b.lot_id, receiptNo: b.receipt_no, amount, serverReceivedAt: new Date(b.server_received_at).toISOString(), commitment: b.commitment };
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
        // в журнал — без суммы (7.4.4)
        await this.audit.log(user.id, 'bid.placed', 'bid', bidId, null, { lotId, receiptNo, commitment }, t);
        const r: BidReceipt = { bidId, lotId, receiptNo, amount, serverReceivedAt: receivedAt.toISOString(), commitment };
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

  async mine(user: User, lotId: number) {
    const b = await this.db.maybe(`SELECT * FROM bids WHERE lot_id=$1 AND user_id=$2`, [lotId, user.id]);
    return b ? this.toReceipt(b) : null;
  }

  /** «Мои ставки» — активные и завершённые. */
  async allMine(user: User) {
    const rows = await this.db.q(
      `SELECT b.*, l.status AS lot_status, l.closes_at, l.start_price, p.property_type, p.settlement, p.street, r.winner_user_id
       FROM bids b JOIN lots l ON l.id=b.lot_id JOIN properties p ON p.id=l.property_id LEFT JOIN lot_results r ON r.lot_id=l.id
       WHERE b.user_id=$1 ORDER BY b.server_received_at DESC`,
      [user.id],
    );
    return rows.map((b) => ({
      ...this.toReceipt(b),
      lotStatus: b.lot_status,
      closesAt: b.closes_at,
      startPrice: b.start_price,
      property: { type: b.property_type, settlement: b.settlement, street: b.street },
      won: b.winner_user_id === user.id,
    }));
  }
}
