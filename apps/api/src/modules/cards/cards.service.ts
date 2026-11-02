import { Injectable } from '@nestjs/common';
import { Db } from '../../common/db';
import { Clock, DAY } from '../../common/clock';
import { fail } from '../../common/errors';
import { Audit } from '../../common/audit';
import { SettingsService } from '../../common/settings';
import { FakeGateway } from '../../adapters/gateway';
import { AuthService, User } from '../auth/auth.service';

const norm = (s: string) => s.toLowerCase().replace(/[^a-zа-яёա-ֆ]/gi, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

/** 6.2 Привязка карты (SC-03). Номер карты вводится только на странице банка. */
@Injectable()
export class CardsService {
  constructor(private db: Db, private clock: Clock, private gw: FakeGateway, private auth: AuthService, private audit: Audit, private settings: SettingsService) {}

  list(userId: number) {
    return this.db.q(`SELECT id, mask, holder_name, created_at FROM cards WHERE user_id=$1 AND status='active' ORDER BY id`, [userId]);
  }

  async startBind(user: User, stepUp: string | undefined) {
    const cooldown = await this.settings.get('phone_change_cooldown_days');
    if (user.phone_changed_at && this.clock.ms() - new Date(user.phone_changed_at).getTime() < cooldown * DAY) fail('PHONE_RECENTLY_CHANGED', 403); // AU-04
    await this.db.tx((t) => this.auth.consumeStepUp(user, 'card_bind', stepUp, t));
    const web = process.env.WEB_URL || 'http://localhost:3000';
    const { orderId, formUrl } = await this.gw.createBindingOrder(10, `${web}/account/cards/return`);
    await this.db.q('INSERT INTO card_bind_orders(order_id, user_id) VALUES ($1,$2)', [orderId, user.id]);
    return { orderId, formUrl };
  }

  /** Возврат с банка: сервер сам спрашивает статус у шлюза, а не доверяет параметрам адреса. */
  async completeBind(user: User, orderId: string) {
    const o = await this.db.maybe<{ status: string }>('SELECT status FROM card_bind_orders WHERE order_id=$1 AND user_id=$2', [orderId, user.id]);
    if (!o) fail('ORDER_NOT_FOUND', 404);
    if (o!.status !== 'created') fail('ORDER_ALREADY_PROCESSED');
    const st = await this.gw.getOrderStatus(orderId);
    if (!st || st.status !== 'approved' || !st.bindingId) {
      await this.db.q(`UPDATE card_bind_orders SET status='failed' WHERE order_id=$1`, [orderId]);
      fail('CARD_BIND_DECLINED');
    }
    await this.gw.reverse(orderId); // проверочная сумма сразу отменяется
    if (st!.holderName && user.full_name && norm(st!.holderName) !== norm(user.full_name)) {
      await this.db.q(`UPDATE card_bind_orders SET status='failed' WHERE order_id=$1`, [orderId]);
      fail('CARD_HOLDER_MISMATCH');
    }
    const card = await this.db.tx(async (t) => {
      await t.q(`UPDATE card_bind_orders SET status='done' WHERE order_id=$1`, [orderId]);
      const ex = await t.maybe(`SELECT id, mask FROM cards WHERE user_id=$1 AND binding_id=$2 AND status='active'`, [user.id, st!.bindingId]);
      if (ex) return ex;
      return t.one(`INSERT INTO cards(user_id, mask, binding_id, holder_name, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, mask`, [user.id, st!.mask, st!.bindingId, st!.holderName ?? null, this.clock.now()]);
    });
    await this.audit.log(user.id, 'card.bound', 'card', card.id, null, { mask: card.mask });
    return card;
  }

  /** Карту нельзя отвязать, пока на ней есть депозит или ожидается комиссия. */
  async remove(user: User, cardId: number, stepUp: string | undefined) {
    await this.db.tx(async (t) => {
      await this.auth.consumeStepUp(user, 'card_delete', stepUp, t);
      const c = await t.maybe(`SELECT id FROM cards WHERE id=$1 AND user_id=$2 AND status='active' FOR UPDATE`, [cardId, user.id]);
      if (!c) fail('CARD_NOT_FOUND', 404);
      const dep = await t.maybe(`SELECT 1 FROM deposits WHERE card_id=$1 AND status IN ('pending','held','releasing','disputed')`, [cardId]);
      if (dep) fail('CARD_HAS_DEPOSIT');
      const com = await t.maybe(
        `SELECT 1 FROM lots l JOIN deals d ON d.lot_id=l.id WHERE l.seller_id=$1 AND d.status IN ('awaiting_confirm','confirmed','extract_uploaded')
         UNION SELECT 1 FROM payments WHERE user_id=$1 AND kind='commission' AND status IN ('pending','failed')`,
        [user.id],
      );
      const count = await t.one<{ c: number }>(`SELECT count(*)::int c FROM cards WHERE user_id=$1 AND status='active'`, [user.id]);
      if (com && count.c <= 1) fail('CARD_COMMISSION_PENDING');
      await t.q(`UPDATE cards SET status='removed' WHERE id=$1`, [cardId]);
    });
    await this.audit.log(user.id, 'card.removed', 'card', cardId);
    return { ok: true };
  }
}
