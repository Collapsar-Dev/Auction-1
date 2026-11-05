import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Интерфейс платёжного шлюза ArCa (6, 6.6). В разработке — фейковый адаптер
 * с теми же методами и управляемыми ответами (P-1).
 *
 * Тестовые карты фейкового банка:
 *   4111 1111 1111 1111 — всё проходит
 *   4000 0000 0000 0002 — банк отклоняет блокировки и списания
 *   4000 0000 0000 0069 — блокировка проходит, списание (комиссия) — нет
 */
export type OrderStatus = 'created' | 'approved' | 'declined' | 'deposited' | 'reversed' | 'refunded';
export interface GatewayOrder {
  orderId: string;
  kind: 'bind' | 'hold' | 'pay';
  amount: number;
  status: OrderStatus;
  bindingId?: string;
  mask?: string;
  holderName?: string;
  returnUrl?: string;
  holdExpiresAt?: string;
  idempotencyKey?: string;
}
export interface PaymentGateway {
  createBindingOrder(amount: number, returnUrl: string): Promise<{ orderId: string; formUrl: string }>;
  getOrderStatus(orderId: string): Promise<GatewayOrder | null>;
  reverse(orderId: string): Promise<boolean>;
  holdByBinding(bindingId: string, amount: number, idempotencyKey: string, holdDays: number, now: Date): Promise<GatewayOrder>;
  payByBinding(bindingId: string, amount: number, idempotencyKey: string): Promise<GatewayOrder>;
  /** списание заблокированной суммы (amount — частичное списание, остаток разблокируется) */
  deposit(orderId: string, amount?: number): Promise<boolean>;
}

type FakeBinding = { bindingId: string; pan: string; mask: string; holderName?: string };

@Injectable()
export class FakeGateway implements PaymentGateway {
  orders = new Map<string, GatewayOrder>();
  bindings = new Map<string, FakeBinding>();
  private byKey = new Map<string, string>();
  /** Состояние песочницы банка сохраняется в файл, чтобы переживать перезапуск сервера. */
  private file = process.env.NODE_ENV === 'test' ? null : path.join(process.env.STORAGE_DIR || path.resolve(process.cwd(), 'storage'), 'fake-gateway.json');
  private loadedMtime = 0;
  constructor() {
    this.sync();
  }
  /** Перечитать файл, если его изменил другой процесс (например, npm run seed при запущенном API). */
  private sync() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const m = fs.statSync(this.file).mtimeMs;
    if (m === this.loadedMtime) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.orders = new Map(j.orders);
      this.bindings = new Map(j.bindings);
      this.byKey = new Map(j.byKey);
      this.loadedMtime = m;
    } catch {
      /* повреждённый файл — работаем с тем, что в памяти */
    }
  }
  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ orders: [...this.orders], bindings: [...this.bindings], byKey: [...this.byKey] }));
    this.loadedMtime = fs.statSync(this.file).mtimeMs;
  }
  reset() {
    this.orders.clear();
    this.bindings.clear();
    this.byKey.clear();
    this.save();
  }

  async createBindingOrder(amount: number, returnUrl: string) {
    this.sync();
    const orderId = 'ord_' + crypto.randomUUID();
    this.orders.set(orderId, { orderId, kind: 'bind', amount, status: 'created', returnUrl });
    const web = process.env.WEB_URL || 'http://localhost:3000';
    this.save();
    return { orderId, formUrl: `${web}/sandbox/bank?orderId=${orderId}` };
  }
  /** Вызывается страницей банка-песочницы: пользователь ввёл карту и прошёл 3-D Secure. */
  submitCardForm(orderId: string, pan: string, holderName: string | undefined, pass3ds: boolean) {
    this.sync();
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'created') return null;
    const digits = pan.replace(/\D/g, '');
    if (!pass3ds || digits.length < 12) {
      o.status = 'declined';
      this.save();
      return o;
    }
    const existing = [...this.bindings.values()].find((b) => b.pan === digits);
    const binding = existing ?? { bindingId: 'bnd_' + crypto.randomUUID(), pan: digits, mask: '•••• ' + digits.slice(-4), holderName };
    if (!existing) this.bindings.set(binding.bindingId, binding);
    Object.assign(o, { status: 'approved', bindingId: binding.bindingId, mask: binding.mask, holderName: holderName || undefined });
    this.save();
    return o;
  }
  /** Для сида: создать привязку без страницы банка. */
  seedBinding(pan: string, holderName?: string) {
    this.sync();
    const digits = pan.replace(/\D/g, '');
    const existing = [...this.bindings.values()].find((b) => b.pan === digits);
    if (existing) return existing;
    const b = { bindingId: 'bnd_seed_' + digits.slice(-4) + '_' + crypto.randomBytes(3).toString('hex'), pan: digits, mask: '•••• ' + digits.slice(-4), holderName };
    this.bindings.set(b.bindingId, b);
    this.save();
    return b;
  }
  /** Привязки сида восстанавливаются по маске после перезапуска (фейковый банк живёт в памяти). */
  restoreBinding(bindingId: string, mask: string) {
    this.sync();
    if (this.bindings.has(bindingId)) return;
    const last4 = mask.replace(/\D/g, '').slice(-4);
    const pan = last4 === '0002' ? '4000000000000002' : last4 === '0069' ? '4000000000000069' : '411111111111' + last4;
    this.bindings.set(bindingId, { bindingId, pan, mask });
    this.save();
  }
  async getOrderStatus(orderId: string) {
    this.sync();
    return this.orders.get(orderId) ?? null;
  }
  async reverse(orderId: string) {
    this.sync();
    const o = this.orders.get(orderId);
    if (!o) return true; // нечего отменять (например, после перезапуска песочницы)
    if (o.status === 'approved') o.status = 'reversed';
    this.save();
    return true;
  }
  async holdByBinding(bindingId: string, amount: number, idempotencyKey: string, holdDays: number, now: Date) {
    this.sync();
    const prev = this.byKey.get(idempotencyKey);
    if (prev) return this.orders.get(prev)!;
    const b = this.bindings.get(bindingId);
    const orderId = 'ord_' + crypto.randomUUID();
    const declined = !b || b.pan.endsWith('0002');
    const o: GatewayOrder = {
      orderId,
      kind: 'hold',
      amount,
      status: declined ? 'declined' : 'approved',
      bindingId,
      idempotencyKey,
      holdExpiresAt: new Date(now.getTime() + holdDays * 86400_000).toISOString(),
    };
    this.orders.set(orderId, o);
    this.byKey.set(idempotencyKey, orderId);
    this.save();
    return o;
  }
  async payByBinding(bindingId: string, amount: number, idempotencyKey: string) {
    this.sync();
    const prev = this.byKey.get(idempotencyKey);
    if (prev) return this.orders.get(prev)!;
    const b = this.bindings.get(bindingId);
    const orderId = 'ord_' + crypto.randomUUID();
    const declined = !b || b.pan.endsWith('0002') || b.pan.endsWith('0069');
    const o: GatewayOrder = { orderId, kind: 'pay', amount, status: declined ? 'declined' : 'deposited', bindingId, idempotencyKey };
    this.orders.set(orderId, o);
    this.byKey.set(idempotencyKey, orderId);
    this.save();
    return o;
  }
  async deposit(orderId: string, amount?: number) {
    this.sync();
    const o = this.orders.get(orderId);
    if (!o) return false;
    const b = o.bindingId ? this.bindings.get(o.bindingId) : undefined;
    if (b?.pan.endsWith('0069')) return false;
    if (amount !== undefined && amount < o.amount) o.amount = amount; // частичное списание
    o.status = 'deposited';
    this.save();
    return true;
  }
}
