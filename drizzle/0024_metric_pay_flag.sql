ALTER TABLE "metric_definitions" ADD COLUMN "is_pay_data" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing metrics whose key, name or aliases name pay data (the AI narrative's word list,
-- src/server/ai/narrative.ts) are flagged; the piecework pay total (a factory total) is not.
UPDATE "metric_definitions"
SET "is_pay_data" = true
WHERE "key" <> 'piecework_total'
  AND (
    ("name" || ' ' || "aliases"::text) ~* '(salar|payroll|wage|bonus|compensation|[Оо][Кк][Лл][Аа][Дд]|[Зз][Аа][Рр][Пп][Лл][Аа][Тт]|[Зз][Аа][Рр][Аа][Бб][Оо][Тт][Нн]|[Бб][Оо][Нн][Уу][Сс]|[Оо][Пп][Лл][Аа][Тт][АаЫыУуЕе]?\s+[Тт][Рр][Уу][Дд][Аа]|[Зз][Аа][Рр]\.?\s*[Пп][Лл][Аа][Тт]|[Зз]\s*/\s*[Пп]|[Пп][Рр][Ее][Мм][Ии](?![Уу][Мм])|(^|[^А-ЯЁа-яё])([Зз][Пп]|[Фф][Оо][Тт])([^А-ЯЁа-яё]|$)|(^|[^a-z])fot([^a-z]|$))'
    OR "key" ~* '(^|_)(salary|salaries|payroll|wages?|fot|zp|oklad|zarplat[a-z]*|zarabotn[a-z]*|bonus(es)?|premi(ya|ia|ja|i|a)?|compensation)(_|$)'
    OR "key" ~ '(^|_)(salary|salaries|payroll|wages?|fot|zp|oklad|zarplat[a-z]*|zarabotn[a-z]*|bonus(es)?|premi(ya|ia|ja|i|a)?|compensation)[A-Z0-9]'
    OR "key" ~ '[a-z0-9](Salary|Salaries|Payroll|Wages?|Fot|Zp|Oklad|Zarplat[a-z]*|Zarabotn[a-z]*|Bonus(es)?|Premi(ya|ia|ja|i|a)?|Compensation)([A-Z0-9_]|$)'
  );
