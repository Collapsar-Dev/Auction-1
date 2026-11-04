-- PRD v2 решение 6: гарантийный взнос задаёт продавец — 0–10 % от начальной цены (в базисных пунктах, 100 = 1 %).
-- NULL = правило v1 (settings.deposit_bp с минимумом и максимумом). 0 = участие без блокировки денег.
ALTER TABLE lots ADD COLUMN guarantee_bp int CHECK (guarantee_bp BETWEEN 0 AND 1000);
