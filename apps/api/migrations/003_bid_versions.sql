-- PRD v2, решение 9: одна ставка на участника, до N изменений (settings.bid_max_changes), в зачёт — последняя версия.
-- Строка bids всегда хранит ТЕКУЩУЮ версию (по ней идёт вскрытие); история — в bid_versions.
-- Суммы и здесь только в зашифрованном виде (R-06, 7.4).

ALTER TABLE bids ADD COLUMN version int NOT NULL DEFAULT 1;

CREATE TABLE bid_versions (
  id                 bigserial PRIMARY KEY,
  bid_id             uuid NOT NULL REFERENCES bids(id),
  version            int NOT NULL,
  ciphertext         text NOT NULL,
  commitment         text NOT NULL,
  owner_ciphertext   text NOT NULL,
  receipt_no         text NOT NULL,
  idempotency_key    text NOT NULL UNIQUE,
  server_received_at timestamptz NOT NULL,
  UNIQUE (bid_id, version)
);

INSERT INTO bid_versions (bid_id, version, ciphertext, commitment, owner_ciphertext, receipt_no, idempotency_key, server_received_at)
SELECT id, 1, ciphertext, commitment, owner_ciphertext, receipt_no, idempotency_key, server_received_at FROM bids;
