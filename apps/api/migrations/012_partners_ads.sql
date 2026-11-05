-- PRD v2 решения 13–14 (F10): лицензированные партнёры, заявки на услуги, кабинет партнёра, реклама с модерацией.

CREATE TABLE partners (
  id             bigserial PRIMARY KEY,
  user_id        bigint NOT NULL UNIQUE REFERENCES users(id),   -- владелец кабинета партнёра
  kind           text NOT NULL CHECK (kind IN ('notary','insurance','appraisal','lawyer')),
  name           text NOT NULL,
  city           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  price_from     text,
  license_no     text NOT NULL,
  license_key    text NOT NULL,                                 -- файл лицензии (закрыт, видит модератор)
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','blocked')),
  reject_reason  text,
  verified_by    bigint REFERENCES users(id),
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL
);

CREATE TABLE service_requests (
  id          bigserial PRIMARY KEY,
  partner_id  bigint NOT NULL REFERENCES partners(id),
  user_id     bigint NOT NULL REFERENCES users(id),
  lot_id      bigint REFERENCES lots(id),
  service     text NOT NULL,                                     -- например insurance_title / notary_contract
  comment     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','rejected','done')),
  reply       text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX ON service_requests (partner_id, status);

CREATE TABLE ad_requests (
  id            bigserial PRIMARY KEY,
  partner_id    bigint NOT NULL REFERENCES partners(id),
  slot          text NOT NULL CHECK (slot IN ('catalog','lot','partners')),
  title         text NOT NULL,
  url           text NOT NULL,
  creative_key  text NOT NULL,
  starts_on     date NOT NULL,
  ends_on       date NOT NULL CHECK (ends_on >= starts_on),
  price         bigint NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','stopped')),
  reject_reason text,
  decided_by    bigint REFERENCES users(id),
  decided_at    timestamptz,
  impressions   bigint NOT NULL DEFAULT 0,
  clicks        bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL
);
CREATE INDEX ON ad_requests (slot, status, starts_on, ends_on);
