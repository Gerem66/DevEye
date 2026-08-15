-- CloudSync : réglages d'exploitation.
--
-- Quatre besoins, tous par partage, tous avec un défaut qui reproduit très
-- exactement le comportement actuel — cette migration ne change RIEN tant que
-- personne ne touche aux réglages :
--
-- 1. `rate_up_bps` / `rate_down_bps` — limites de bande passante en octets par
--    seconde. NULL = illimité, ce qui est le défaut et le comportement actuel.
--    Le limiteur vit chez l'émetteur : le serveur pour les descentes, l'agent
--    pour les montées (valeur poussée dans `sync.config`).
--
-- 2. `trash_keep_days` — durée de la corbeille locale de l'agent
--    (`.deveye-trash/`), jusqu'ici codée en dur à 30 jours dans le scanner.
--
-- 3. `integrity_scan_enabled` — balayage d'intégrité de fond. Le prune horaire
--    relit un petit budget de blobs par tour et vérifie tag GCM + SHA-256. La
--    position courante n'est PAS ici : elle vit dans `sync_meta`, qui est déjà
--    la table clé/valeur du sous-système et évite une colonne de plus dont la
--    valeur change toutes les heures.
--
-- Les DDL de MySQL committent implicitement : une migration qui casse au milieu
-- reste à moitié appliquée SANS être enregistrée dans `_migrations`, et la
-- relance butterait sur les colonnes déjà là. L'ajout est donc gardé, comme
-- dans 071 et 081.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND COLUMN_NAME = 'rate_up_bps');
SET @s = IF(@c = 0,
    'ALTER TABLE sync_shares
         ADD COLUMN rate_up_bps            BIGINT  NULL,
         ADD COLUMN rate_down_bps          BIGINT  NULL,
         ADD COLUMN trash_keep_days        INT     NOT NULL DEFAULT 30,
         ADD COLUMN integrity_scan_enabled TINYINT NOT NULL DEFAULT 1',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
