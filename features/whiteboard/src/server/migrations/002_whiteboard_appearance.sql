-- L apparence d un tableau, choisie dans le menu d Excalidraw et commune a
-- tous ses participants : la couleur du fond (NULL, celle d Excalidraw) et le
-- theme (NULL, celui du profil de chaque membre). En clair : ni l une ni
-- l autre ne dit rien du dessin.
--
-- Rejouable : sonde d existence, puis ajout sous garde. MySQL ne connait pas
-- ADD COLUMN IF NOT EXISTS.

SET @has_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ft_whiteboard_boards'
      AND COLUMN_NAME = 'background');

SET @s = IF(@has_column = 0,
    'ALTER TABLE ft_whiteboard_boards ADD COLUMN background VARCHAR(32) NULL AFTER preview_version, ADD COLUMN theme VARCHAR(5) NULL AFTER background',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
