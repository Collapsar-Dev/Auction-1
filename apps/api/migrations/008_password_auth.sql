-- PRD v2 решение 1: вход по email или телефону + пароль; подтверждение контакта кодом; сброс пароля.
-- Вход по SMS-коду (v1) остаётся — для уже зарегистрированных по телефону.
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
UPDATE users SET phone_verified_at = created_at WHERE phone IS NOT NULL AND role = 'user'; -- v1: телефон подтверждён SMS-входом
ALTER TABLE users ADD COLUMN login_failed int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN login_locked_until timestamptz;
CREATE UNIQUE INDEX users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_purpose_check;
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check CHECK (purpose IN ('login','step_up','phone_old','phone_new','register'));

-- коды подтверждения email (телефон — через otp_codes)
CREATE TABLE email_codes (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('register')),
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL
);
CREATE INDEX ON email_codes (email, purpose, created_at DESC);

-- «Забыли пароль»: одноразовая ссылка; в базе — только хэш токена
CREATE TABLE password_resets (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL
);
