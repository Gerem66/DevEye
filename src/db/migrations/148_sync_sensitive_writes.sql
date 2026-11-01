-- CloudSync : un partage peut laisser le serveur écrire dans ses dossiers
-- sensibles (.ssh, dossiers de démarrage, fichiers du shell d'un foyer).
-- Refusé par défaut, et l'agent n'honore l'accord que si sa politique locale
-- autorise le terminal. Ajout conditionnel via INFORMATION_SCHEMA.
SET @ss_sensitive_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND COLUMN_NAME = 'sensitive_writes');
SET @add_ss_sensitive = IF(@ss_sensitive_exists = 0,
    'ALTER TABLE sync_shares ADD COLUMN sensitive_writes TINYINT NOT NULL DEFAULT 0',
    'SELECT 1');
PREPARE stmt FROM @add_ss_sensitive; EXECUTE stmt; DEALLOCATE PREPARE stmt;
