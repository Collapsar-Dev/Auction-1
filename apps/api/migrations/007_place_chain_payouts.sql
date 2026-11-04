-- PRD v2 решения 7–8: цепочка мест 1 → 2 → 3 (settings.chain_places), у каждого 48 ч.
-- Удержанный взнос отказавшегося (решение администратора «удержать») делится: продавцу и платформе
-- (settings.forfeit_platform_bp, по умолчанию 20 %). Выплата фиксируется здесь; перевод денег — отдельно.
CREATE TABLE payouts (
  id         bigserial PRIMARY KEY,
  lot_id     bigint NOT NULL REFERENCES lots(id),
  deposit_id bigint NOT NULL REFERENCES deposits(id),
  recipient  text NOT NULL CHECK (recipient IN ('seller','platform')),
  user_id    bigint REFERENCES users(id),          -- продавец; NULL для платформы
  amount     bigint NOT NULL,
  reason     text NOT NULL DEFAULT 'forfeited_guarantee',
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
  created_at timestamptz NOT NULL,
  UNIQUE (deposit_id, recipient)
);
