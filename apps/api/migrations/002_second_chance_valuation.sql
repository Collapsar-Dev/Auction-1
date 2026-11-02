-- v0.2: второй шанс (лот переходит 2-му месту), оценка недвижимости, проверенные документы

-- Сделка может перейти участнику со 2-го места (раунд 2)
ALTER TABLE deals ADD COLUMN round int NOT NULL DEFAULT 1;
ALTER TABLE deals ADD COLUMN prev_winner_user_id bigint REFERENCES users(id);
ALTER TABLE deals ADD COLUMN transferred_at timestamptz;

-- Отметки модератора при одобрении: что именно проверено
ALTER TABLE lots ADD COLUMN verification jsonb NOT NULL DEFAULT '{}';

-- Оценка объекта независимой организацией
CREATE TABLE property_valuations (
  id           bigserial PRIMARY KEY,
  property_id  bigint NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  org_name     text NOT NULL,
  amount       bigint NOT NULL CHECK (amount > 0),
  valued_at    date NOT NULL,
  report_no    text,
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
