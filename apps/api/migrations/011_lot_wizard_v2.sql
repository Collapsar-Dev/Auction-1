-- PRD v2 (F9): создание лота в 5 шагов — проверка по кадастру, фото по комнатам, документы, страховка, переписка с модератором.

ALTER TABLE property_media DROP CONSTRAINT property_media_kind_check;
ALTER TABLE property_media ADD CONSTRAINT property_media_kind_check CHECK (kind IN ('photo','extract','document'));
ALTER TABLE property_media ADD COLUMN room text;       -- у фото: facade / living / kitchen / bedroom / bathroom / view / plan / yard / other
ALTER TABLE property_media ADD COLUMN doc_type text;   -- у документа: encumbrance / tech_passport / co_owner_consent / power_of_attorney / insurance_policy

ALTER TABLE lots ADD COLUMN cadastre_check jsonb;      -- итог проверки кадастрового номера
ALTER TABLE lots ADD COLUMN insurance jsonb;           -- { mode: have|order|none, insurer, policy_no, valid_until }

CREATE TABLE lot_messages (
  id          bigserial PRIMARY KEY,
  lot_id      bigint NOT NULL REFERENCES lots(id),
  author_id   bigint NOT NULL REFERENCES users(id),
  author_role text NOT NULL CHECK (author_role IN ('seller','staff')),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL
);
CREATE INDEX ON lot_messages (lot_id, id);
