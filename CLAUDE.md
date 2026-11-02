# Аукцион тип 1 — заметки для Claude Code

- Источник истины — PRD «Аукцион тип 1» (номера правил R-, AU-, SC-, Q- используются в коде и тестах).
- Монорепозиторий npm workspaces: `apps/api` (NestJS + PostgreSQL, SQL-миграции в `apps/api/migrations`), `apps/web` (Next.js).
- Все числа правил — в `settings` (`apps/api/src/common/settings.ts`), не в коде.
- Деньги — целые драмы, время — серверное `Clock` (не `Date.now()`), в UTC.
- Суммы ставок до итога нигде не появляются в открытом виде: ни в логах, ни в журнале, ни в API (R-06, 7.4).
- Перед изменениями денег, ставок и прав доступа — сначала тест (`apps/api/test`, `npm test`; нужна база `auction_test`).
- Решения и отклонения от PRD — `docs/ADR-001.md`.
