import { Injectable } from '@nestjs/common';
import { Db, Queryable } from './db';

/** Все числа правил — в таблице settings (PRD 2). Здесь — значения по умолчанию. */
export const DEFAULT_SETTINGS = {
  min_start_price: 1_000_000, // R-01
  duration_min_hours: 72, // R-02: 3 дня
  duration_max_hours: 336, // R-02: 14 дней
  start_delay_hours: 24, // R-02: старт не раньше чем через 24 ч после одобрения
  deposit_bp: 100, // R-13: 1% (в базисных пунктах)
  deposit_min: 200_000,
  deposit_max: 2_000_000,
  guarantee_default_bp: 100, // PRD v2 решение 6: взнос по умолчанию в мастере — 1 %
  guarantee_max_bp: 1000, // PRD v2: максимум 10 %
  commission_bp: 50, // R-17: 0,5%
  commission_min: 100_000,
  deal_confirm_hours: 48, // R-16
  notary_days: 10,
  reveal_deadline_sec: 60, // R-09
  reveal_alarm_min: 5, // SC-11
  outage_threshold_min: 5, // R-08
  outage_extend_hours: 24,
  otp_ttl_sec: 300, // AU-01
  otp_attempts: 5,
  seller_plans_enabled: true, // PRD v2 решение 16: отправить лот на модерацию можно только с размещением по тарифу продавца
  seller_deposit_enabled: true, // PRD v2 решение 17: возвратный взнос продавца, блок с открытия регистрации
  seller_deposit_min: 100_000, // не меньше (процент — как у взноса участника)
  seller_cancel_registration_bp: 2500, // снял лот после открытия регистрации, до торгов — удержание 25 %
  seller_forfeit_buyer_bp: 8000, // из удержанного: 80 % победителю / участникам, остальное платформе
  kyc_require_moderator: true, // PRD v2 решение 2: заключение KYC-сервиса → решение модератора (false = как в v1, сразу «проверен»)
  password_min_length: 8, // PRD v2 решение 1: пароль — минимум 8 символов, буквы и цифры
  login_max_attempts: 5, // неверный пароль N раз подряд → вход закрыт на login_lock_min минут
  login_lock_min: 15,
  email_code_ttl_min: 10, // код подтверждения email
  reset_ttl_min: 30, // ссылка «забыли пароль»
  otp_resend_sec: 60,
  otp_daily_max: 10,
  stepup_ttl_sec: 300, // AU-03
  phone_change_cooldown_days: 7, // AU-04
  photos_min: 10, // SC-04
  photo_rooms_required: 'living,kitchen,bathroom', // PRD v2 (F9.3): обязательные подписи комнат у фото (через запятую; пусто — не проверять)
  photos_max: 30,
  extract_max_workdays: 15,
  hold_days: 30, // Q-02: срок блокировки в фейковом банке
  hold_renew_hours: 72,
  commission_retry_days: 3,
  standard_max_active_bids: 2, // R-20
  standard_max_open_deals: 1, // R-19
  investor_max_active_bids: 5, // R-21
  investor_max_open_deals: 3,
  investor_days: 90,
  funds_proof_max_age_days: 30,
  funds_proof_keep_days: 180,
  s1_wins: 3, // 6A.2
  s1_days: 30,
  s2_gap_pct: 30,
  s2_start_mult: 2,
  s3_months: 12,
  s6_sum: 200_000_000,
  s6_days: 90,
  sanction_days_1: 30, // 6A.3
  sanction_days_2: 180,
  subscription_reminder_days: [14, 3],
  dispute_hours: 48, // SC-19
  bid_max_changes: 3, // PRD v2 решение 9: сколько раз можно изменить ставку до конца торгов (в зачёт — последняя версия)
  second_chance_days: 0, // v0.2: окно «второго шанса» в днях после итога; PRD v2 — 0 = без окна (места держатся до договора)
  chain_places: 3, // PRD v2 решение 8: сколько мест держат взнос и по очереди получают лот (1 = только победитель)
  forfeit_platform_bp: 2000, // PRD v2 §6 вариант B: доля платформы с удержанного взноса — 20 % (решается с юристом)
  results_show_user_ids: 1, // v0.2: после итога показывать ID участников рядом со ставками (1 = да, 0 = нет)
  consent_versions: { terms: '1.0', privacy: '1.0', biometrics: '1.0', auction_rules: '1.0', seller_offer: '1.0' },
};
export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

@Injectable()
export class SettingsService {
  constructor(private db: Db) {}

  async all(t: Queryable = this.db): Promise<Settings> {
    const rows = await t.q<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    const s: any = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in s) s[r.key] = r.value;
    return s as Settings;
  }

  async get<K extends SettingKey>(key: K, t: Queryable = this.db): Promise<Settings[K]> {
    const r = await t.maybe<{ value: Settings[K] }>('SELECT value FROM settings WHERE key=$1', [key]);
    return r ? r.value : DEFAULT_SETTINGS[key];
  }

  async set(key: SettingKey, value: unknown, by: number | null, t: Queryable = this.db) {
    await t.q(
      `INSERT INTO settings(key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [key, JSON.stringify(value), by],
    );
  }
}

/** 6.1: депозит — 1% от начальной цены в пределах [min, max]. Не зависит от ставки. */
/**
 * PRD v2 решение 6: взнос по проценту продавца (guarantee_bp, 0–1000 б.п.) — ровно этот процент, без мин/макс.
 * Без процента (NULL) — правило v1 depositFor.
 */
export function guaranteeFor(startPrice: number, guaranteeBp: number | null | undefined, s: Pick<Settings, 'deposit_bp' | 'deposit_min' | 'deposit_max'>) {
  if (guaranteeBp === null || guaranteeBp === undefined) return depositFor(startPrice, s);
  return Math.floor((startPrice * guaranteeBp) / 10_000);
}

export function depositFor(startPrice: number, s: Pick<Settings, 'deposit_bp' | 'deposit_min' | 'deposit_max'>) {
  const raw = Math.floor((startPrice * s.deposit_bp) / 10_000);
  return Math.min(s.deposit_max, Math.max(s.deposit_min, raw));
}

/** R-17: комиссия продавца — 0,5% от цены, не меньше минимума. */
export function commissionFor(price: number, s: Pick<Settings, 'commission_bp' | 'commission_min'>) {
  return Math.max(s.commission_min, Math.floor((price * s.commission_bp) / 10_000));
}
