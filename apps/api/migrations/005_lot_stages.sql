-- PRD v2, решение 11 и §2: отдельные даты лота и статусы для покупателя.
-- published_at          — когда лот появляется в каталоге («Скоро»); NULL = сразу после одобрения
-- registration_opens_at — когда открывается «Участвовать»; NULL = сразу после публикации
-- allow_late_registration — можно ли зарегистрироваться, когда торги уже идут
ALTER TABLE lots ADD COLUMN published_at timestamptz;
ALTER TABLE lots ADD COLUMN registration_opens_at timestamptz;
ALTER TABLE lots ADD COLUMN allow_late_registration boolean NOT NULL DEFAULT true;
