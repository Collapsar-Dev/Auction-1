-- PRD v2, решения 4–5: тарифы по ЧИСЛУ УЧАСТИЙ (Standard 10, VIP 50, Premium — без лимита).
-- «Участвовать» (регистрация на лот = блокировка взноса) списывает 1 попытку; отмена лота или
-- отказ банка в блокировке — возвращает её; модератор может вернуть или начислить попытку вручную.

ALTER TABLE plans ADD COLUMN participation_limit int;                       -- NULL = без лимита
ALTER TABLE plans ADD COLUMN sees_valuation_amount boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN participation_limit int;               -- копия на момент покупки
ALTER TABLE subscriptions ADD COLUMN participations_used int NOT NULL DEFAULT 0;

CREATE TABLE participation_credits (
  id              bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES subscriptions(id),
  user_id         bigint NOT NULL REFERENCES users(id),
  lot_id          bigint REFERENCES lots(id),
  type            text NOT NULL CHECK (type IN ('spent','refunded','granted')),
  reason          text,
  actor_id        bigint REFERENCES users(id),           -- NULL = система
  created_at      timestamptz NOT NULL
);
CREATE INDEX participation_credits_user_lot ON participation_credits(user_id, lot_id);
