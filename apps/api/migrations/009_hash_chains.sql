-- PRD v2 (F8): история транзакций и журнал с хэш-цепочкой.
-- ledger — движения по «Счёту участника», заполняется триггерами (ни одно место в коде не пропустит запись).
-- hash_chain — хэши: hash = sha256(prev_hash | поля записи). Цепочки: 'audit' и 'ledger:<user_id>'.
-- Обе таблицы — только на добавление.

CREATE TABLE ledger (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  kind       text NOT NULL,          -- guarantee_held / guarantee_released / guarantee_charged / payment_<kind> / try_spent / try_refunded / try_granted
  amount     bigint NOT NULL,        -- драмы (для попыток — 1)
  ref        text NOT NULL,          -- deposit:12 / payment:5 / credit:7
  lot_id     bigint,
  created_at timestamptz NOT NULL
);
CREATE INDEX ON ledger (user_id, id);

CREATE TABLE hash_chain (
  seq       bigserial PRIMARY KEY,
  chain     text NOT NULL,
  ref_id    bigint NOT NULL,
  prev_hash text NOT NULL,
  hash      text NOT NULL,
  sealed_at timestamptz NOT NULL,
  UNIQUE (chain, ref_id)
);

CREATE FUNCTION append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER hash_chain_append_only BEFORE UPDATE OR DELETE ON hash_chain FOR EACH ROW EXECUTE FUNCTION append_only();

-- взносы: каждое изменение статуса на held / released / charged — запись в ledger
CREATE FUNCTION ledger_from_deposit() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('held','released','charged') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO ledger(user_id, kind, amount, ref, lot_id, created_at)
    VALUES (NEW.user_id, 'guarantee_' || NEW.status, NEW.amount, 'deposit:' || NEW.id, NEW.lot_id, NEW.updated_at);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER deposits_ledger AFTER INSERT OR UPDATE OF status ON deposits FOR EACH ROW EXECUTE FUNCTION ledger_from_deposit();

-- оплаты (тарифы, комиссия и т. д.) — когда оплачено
CREATE FUNCTION ledger_from_payment() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'paid' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO ledger(user_id, kind, amount, ref, lot_id, created_at)
    VALUES (NEW.user_id, 'payment_' || NEW.kind, NEW.amount, 'payment:' || NEW.id, NEW.lot_id, coalesce(NEW.created_at, now()));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER payments_ledger AFTER INSERT OR UPDATE OF status ON payments FOR EACH ROW EXECUTE FUNCTION ledger_from_payment();

-- попытки тарифа
CREATE FUNCTION ledger_from_credit() RETURNS trigger AS $$
BEGIN
  INSERT INTO ledger(user_id, kind, amount, ref, lot_id, created_at)
  VALUES (NEW.user_id, 'try_' || NEW.type, 1, 'credit:' || NEW.id, NEW.lot_id, NEW.created_at);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER credits_ledger AFTER INSERT ON participation_credits FOR EACH ROW EXECUTE FUNCTION ledger_from_credit();
