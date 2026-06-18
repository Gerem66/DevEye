-- bgBlur changed from a boolean toggle to a 0–100 intensity slider.
-- Convert the stored JSON: old `true` -> 50, old `false` -> 0.
-- Rows whose theme JSON has no bgBlur key, or already store a number, are left untouched.
UPDATE users
SET theme = JSON_SET(theme, '$.bgBlur',
        CASE WHEN JSON_EXTRACT(theme, '$.bgBlur') = CAST('true' AS JSON) THEN 50 ELSE 0 END)
WHERE theme IS NOT NULL
  AND JSON_TYPE(JSON_EXTRACT(theme, '$.bgBlur')) = 'BOOLEAN';
