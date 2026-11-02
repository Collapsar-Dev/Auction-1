-- Аукцион тип 1 — схема базы (PRD 7.2, 6A.5)
-- Деньги: bigint в драмах. Время: timestamptz (UTC).

CREATE TABLE users (
  id               bigserial PRIMARY KEY,
  phone            text UNIQUE,
  email            text,
  email_verified_at timestamptz,
  email_token      text,
  lang             text NOT NULL DEFAULT 'hy' CHECK (lang IN ('hy','ru','en')),
  kyc_level        int  NOT NULL DEFAULT 0,          -- 0 гость/нет, 1 = L1, 2 = L2
  kyc_status       text NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','manual','verified','rejected')),
  kyc_reject_reason text,
  kyc_session_id   text,
  kyc_pending      jsonb,                             -- данные для ручной проверки
  full_name        text,
  birth_date       date,
  doc_hash         text UNIQUE,                       -- AU-07: только хэш номера документа
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  role             text NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  username         text UNIQUE,                       -- для сотрудников (AU-05)
  password_hash    text,
  totp_secret      text,
  seller_blocked   boolean NOT NULL DEFAULT false,    -- SC-17, 6.4
  seller_block_reason text,
  phone_changed_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  kind        text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','staff')),
  refresh_hash text,
  device      text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- AU-02: история использованных refresh-токенов для обнаружения повторного использования
CREATE TABLE refresh_history (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  used_at    timestamptz NOT NULL
);

CREATE TABLE otp_codes (
  id          bigserial PRIMARY KEY,
  phone       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('login','step_up','phone_old','phone_new')),
  action      text,
  code_hash   text NOT NULL,
  attempts    int  NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL
);
CREATE INDEX ON otp_codes (phone, purpose, created_at DESC);

CREATE TABLE step_up_tokens (
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  action     text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE consents (
  user_id     bigint NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, kind, version)
);

CREATE TABLE cards (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  mask        text NOT NULL,
  binding_id  text NOT NULL,
  holder_name text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_bind_orders (
  order_id   text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  status     text NOT NULL DEFAULT 'created',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id             bigserial PRIMARY KEY,
  owner_id       bigint NOT NULL REFERENCES users(id),
  property_type  text CHECK (property_type IN ('house','apartment')),
  cadastral_no   text,
  region         text,
  settlement     text,
  street         text,
  geo_lat        double precision,
  geo_lng        double precision,
  area_m2        numeric,
  rooms          int,
  bathrooms      int,
  year_built     int,
  heating        text,
  condition      text,
  description_i18n jsonb NOT NULL DEFAULT '{}',
  land_area_m2   numeric,
  floors         int,
  wall_material  text,
  gas            boolean,
  water          boolean,
  sewage         boolean,
  floor          int,
  building_floors int,
  building_type  text,
  has_elevator   boolean,
  has_balcony    boolean,
  parking        boolean
);

CREATE TABLE property_media (
  id          bigserial PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('photo','extract')),
  storage_key text NOT NULL,
  is_private  boolean NOT NULL DEFAULT false,
  sort        int NOT NULL DEFAULT 0,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lots (
  id            bigserial PRIMARY KEY,
  property_id   bigint NOT NULL REFERENCES properties(id),
  seller_id     bigint NOT NULL REFERENCES users(id),
  auction_type  text NOT NULL DEFAULT 'type1',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','moderation','needs_changes','rejected','scheduled','live','revealing','finished','no_sale','sold','withdrawn','invalidated')),
  draft_step    int NOT NULL DEFAULT 1,
  start_price   bigint,
  opens_at      timestamptz,
  closes_at     timestamptz,
  deposit_amount bigint,
  public_key    text,
  private_key_wrapped text,
  rules_snapshot jsonb,
  winner_bid_id uuid,
  relaunched_from bigint REFERENCES lots(id),
  approved_at   timestamptz,
  ended_reason  text,
  extended_at   timestamptz,
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lots (status, closes_at);

CREATE TABLE moderation (
  id           bigserial PRIMARY KEY,
  lot_id       bigint NOT NULL REFERENCES lots(id),
  moderator_id bigint REFERENCES users(id),
  decision     text NOT NULL,
  comment      text,
  created_at   timestamptz NOT NULL
);

CREATE TABLE deposits (
  id               bigserial PRIMARY KEY,
  lot_id           bigint NOT NULL REFERENCES lots(id),
  user_id          bigint NOT NULL REFERENCES users(id),
  card_id          bigint REFERENCES cards(id),
  amount           bigint NOT NULL,
  gateway_order_id text,
  status           text NOT NULL CHECK (status IN ('pending','held','failed','releasing','released','disputed','charged')),
  hold_expires_at  timestamptz,
  fail_reason      text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX deposits_one_active ON deposits (lot_id, user_id) WHERE status IN ('pending','held','releasing','disputed');

CREATE TABLE plans (
  id              serial PRIMARY KEY,
  code            text UNIQUE NOT NULL,
  name_i18n       jsonb NOT NULL,
  price           bigint NOT NULL,
  duration_days   int NOT NULL,
  max_start_price bigint,          -- null = без ограничений
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE payments (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('subscription','upgrade','commission','card_check')),
  lot_id           bigint REFERENCES lots(id),
  user_id          bigint NOT NULL REFERENCES users(id),
  amount           bigint NOT NULL,
  gateway_order_id text,
  idempotency_key  text UNIQUE,
  status           text NOT NULL CHECK (status IN ('pending','paid','failed','cancelled')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  receipt_no       text,
  created_at       timestamptz NOT NULL
);

CREATE TABLE subscriptions (
  id              bigserial PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id),
  plan_id         int NOT NULL REFERENCES plans(id),
  price_paid      bigint NOT NULL,
  max_start_price bigint,          -- копия на момент покупки
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  payment_id      bigint REFERENCES payments(id),
  source          text NOT NULL CHECK (source IN ('paid','admin_grant')),
  grant_reason    text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','upgraded','cancelled')),
  created_at      timestamptz NOT NULL
);

CREATE TABLE bids (
  id                 uuid PRIMARY KEY,
  lot_id             bigint NOT NULL REFERENCES lots(id),
  user_id            bigint NOT NULL REFERENCES users(id),
  subscription_id    bigint REFERENCES subscriptions(id),
  ciphertext         text NOT NULL,
  commitment         text NOT NULL,
  idempotency_key    text NOT NULL UNIQUE,
  receipt_no         text NOT NULL,
  server_received_at timestamptz NOT NULL,
  owner_ciphertext   text NOT NULL,     -- сумма, зашифрованная ключом сервера: только для показа самому участнику
  amount             bigint,            -- заполняется только после вскрытия
  salt               text,              -- раскрывается при вскрытии, чтобы любой мог проверить контрольный код
  UNIQUE (lot_id, user_id)              -- R-05: одна ставка на участника
);

CREATE TABLE lot_results (
  lot_id         bigint PRIMARY KEY REFERENCES lots(id),
  ranking        jsonb NOT NULL,
  winner_user_id bigint REFERENCES users(id),
  revealed_at    timestamptz NOT NULL
);

CREATE TABLE deals (
  lot_id              bigint PRIMARY KEY REFERENCES lots(id),
  winner_user_id      bigint NOT NULL REFERENCES users(id),
  seller_id           bigint NOT NULL REFERENCES users(id),
  amount              bigint NOT NULL,
  confirm_deadline    timestamptz NOT NULL,
  seller_confirmed_at timestamptz,
  buyer_confirmed_at  timestamptz,
  status              text NOT NULL CHECK (status IN ('awaiting_confirm','confirmed','extract_uploaded','sold','buyer_failed','seller_failed','invalidated')),
  new_extract_key     text,
  extract_uploaded_at timestamptz,
  closed_at           timestamptz,
  fail_reason         text
);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    bigint REFERENCES users(id),
  channel    text NOT NULL CHECK (channel IN ('email','sms','inapp')),
  to_addr    text,
  template   text NOT NULL,
  lang       text NOT NULL DEFAULT 'hy',
  subject    text,
  body       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts   int NOT NULL DEFAULT 0,
  last_error text,
  dedupe_key text UNIQUE,
  sealed     boolean NOT NULL DEFAULT false, -- тело зашифровано (квитанция со ставкой до итога, 7.4.4)
  read_at    timestamptz,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX ON notifications (status, created_at);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  actor_id  bigint,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  before    jsonb,
  after     jsonb,
  at        timestamptz NOT NULL
);
-- журнал только на добавление
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE favorites (
  user_id bigint NOT NULL REFERENCES users(id),
  lot_id  bigint NOT NULL REFERENCES lots(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lot_id)
);

CREATE TABLE disputes (
  id          bigserial PRIMARY KEY,
  lot_id      bigint NOT NULL REFERENCES lots(id),
  user_id     bigint NOT NULL REFERENCES users(id),
  receipt_no  text,
  commitment  text,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  admin_reply text,
  created_at  timestamptz NOT NULL,
  answered_at timestamptz
);

CREATE TABLE outages (
  id           bigserial PRIMARY KEY,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'detected' CHECK (status IN ('detected','applied','dismissed')),
  lot_ids      jsonb NOT NULL DEFAULT '[]',
  decided_by   bigint,
  created_at   timestamptz NOT NULL
);

-- 6A. Риски
CREATE TABLE buyer_limits (
  user_id         bigint PRIMARY KEY REFERENCES users(id),
  tier            text NOT NULL CHECK (tier IN ('standard','investor')),
  max_active_bids int NOT NULL,
  max_open_deals  int NOT NULL,
  buying_power    bigint,
  valid_until     timestamptz,
  set_by          bigint,
  reason          text
);

CREATE TABLE funds_proofs (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  storage_key text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by bigint,
  comment     text,
  decided_at  timestamptz,
  delete_after timestamptz NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE TABLE risk_flags (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  lot_id      bigint REFERENCES lots(id),
  signal      text NOT NULL CHECK (signal IN ('S-1','S-2','S-3','S-4','S-5','S-6')),
  details     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','actioned')),
  reviewed_by bigint,
  comment     text,
  created_at  timestamptz NOT NULL,
  UNIQUE (user_id, lot_id, signal)
);

CREATE TABLE sanctions (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  doc_hash   text,
  kind       text NOT NULL CHECK (kind IN ('bid_block','permanent','funds_request')),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz,
  reason     text NOT NULL,
  strike_no  int,
  lot_id     bigint REFERENCES lots(id),
  voided_at  timestamptz,
  created_by bigint,
  created_at timestamptz NOT NULL
);

CREATE TABLE device_fingerprints (
  user_id          bigint NOT NULL REFERENCES users(id),
  fingerprint_hash text NOT NULL,
  ip_hash          text NOT NULL,
  first_seen       timestamptz NOT NULL,
  last_seen        timestamptz NOT NULL,
  PRIMARY KEY (user_id, fingerprint_hash, ip_hash)
);

CREATE TABLE heartbeats (id int PRIMARY KEY, at timestamptz NOT NULL);

CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
