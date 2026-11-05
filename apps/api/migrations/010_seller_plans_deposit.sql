-- PRD v2 решения 16–17: тарифы продавца (плата за размещение) и возвратный гарантийный взнос продавца.

CREATE TABLE seller_plans (
  id            serial PRIMARY KEY,
  code          text UNIQUE NOT NULL,
  name_i18n     jsonb NOT NULL,
  price         bigint NOT NULL,
  period_days   int,            -- NULL = разовое, без срока
  listing_limit int,            -- NULL = без лимита
  max_active    int,            -- NULL = без ограничения одновременно активных
  priority      boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true
);
INSERT INTO seller_plans(code, name_i18n, price, period_days, listing_limit, max_active, priority) VALUES
  ('single',    '{"hy":"Մեկանգամյա","ru":"Разовое","en":"Single"}',      10000, NULL, 1,    NULL, false),
  ('pack10',    '{"hy":"Փաթեթ 10","ru":"Пакет 10","en":"Pack of 10"}',  50000, 365,  10,   NULL, false),
  ('unlimited', '{"hy":"Անսահմանափակ","ru":"Безлимит","en":"Unlimited"}', 250000, 365, NULL, 20,   true);

CREATE TABLE seller_subscriptions (
  id             bigserial PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id),
  seller_plan_id int NOT NULL REFERENCES seller_plans(id),
  price_paid     bigint NOT NULL,
  listing_limit  int,
  max_active     int,
  listings_used  int NOT NULL DEFAULT 0,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,              -- NULL = без срока (разовое)
  payment_id     bigint REFERENCES payments(id),
  source         text NOT NULL CHECK (source IN ('paid','admin_grant')),
  created_at     timestamptz NOT NULL
);

CREATE TABLE listing_credits (
  id                     bigserial PRIMARY KEY,
  seller_subscription_id bigint REFERENCES seller_subscriptions(id),
  user_id                bigint NOT NULL REFERENCES users(id),
  lot_id                 bigint REFERENCES lots(id),
  type                   text NOT NULL CHECK (type IN ('reserved','spent','released','free_relist','granted')),
  reason                 text,
  actor_id               bigint REFERENCES users(id),
  created_at             timestamptz NOT NULL
);
CREATE INDEX ON listing_credits (lot_id);

CREATE TABLE seller_deposits (
  lot_id           bigint PRIMARY KEY REFERENCES lots(id),
  user_id          bigint NOT NULL REFERENCES users(id),
  card_id          bigint REFERENCES cards(id),
  amount           bigint NOT NULL,
  status           text NOT NULL CHECK (status IN ('held','failed','releasing','released','charged')),
  charged_amount   bigint NOT NULL DEFAULT 0,
  gateway_order_id text,
  reason           text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

ALTER TABLE payments DROP CONSTRAINT payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('subscription','upgrade','commission','card_check','seller_plan'));

-- выплаты из удержанного взноса продавца: получатель — победитель/участник или платформа
ALTER TABLE payouts ALTER COLUMN deposit_id DROP NOT NULL;
ALTER TABLE payouts ADD COLUMN seller_lot_id bigint REFERENCES lots(id);
ALTER TABLE payouts DROP CONSTRAINT payouts_recipient_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_recipient_check CHECK (recipient IN ('seller','platform','buyer'));
ALTER TABLE payouts DROP CONSTRAINT payouts_deposit_id_recipient_key;
CREATE UNIQUE INDEX payouts_deposit_recipient ON payouts (deposit_id, recipient) WHERE deposit_id IS NOT NULL;
CREATE UNIQUE INDEX payouts_seller_lot_recipient ON payouts (seller_lot_id, recipient, user_id) WHERE seller_lot_id IS NOT NULL;

CREATE FUNCTION ledger_from_seller_deposit() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('held','released','charged') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO ledger(user_id, kind, amount, ref, lot_id, created_at)
    VALUES (NEW.user_id, 'seller_guarantee_' || NEW.status, CASE WHEN NEW.status = 'charged' THEN NEW.charged_amount ELSE NEW.amount END,
            'seller_deposit:' || NEW.lot_id, NEW.lot_id, NEW.updated_at);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER seller_deposits_ledger AFTER INSERT OR UPDATE OF status ON seller_deposits FOR EACH ROW EXECUTE FUNCTION ledger_from_seller_deposit();
