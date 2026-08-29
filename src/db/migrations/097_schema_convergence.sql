-- Convergence du schéma historique avec une installation neuve. Trois écarts,
-- nés de migrations mail fondues dans `039_mail.sql` avant d'être commitées :
-- leurs noms restent dans `_migrations` sans fichier, et deux colonnes qu'elles
-- avaient posées ne sont lues nulle part.
-- Chaque étape est sans effet sur une base neuve (INFORMATION_SCHEMA + SQL
-- dynamique).

-- 1. `mail_folders.first_seen_uid` : INT dans l'historique, BIGINT dans le dépôt
--    (un UID IMAP est un entier 32 bits non signé, INT signé ne le couvre pas).
ALTER TABLE mail_folders MODIFY COLUMN first_seen_uid BIGINT NULL;

-- 2. `mail_settings.default_send_account_id` : jamais lu, jamais renseigné.
SET @has_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings' AND COLUMN_NAME = 'default_send_account_id');
SET @has_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings' AND CONSTRAINT_NAME = 'fk_mail_settings_account');
SET @s = IF(@has_fk = 1, 'ALTER TABLE mail_settings DROP FOREIGN KEY fk_mail_settings_account', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = IF(@has_col = 1, 'ALTER TABLE mail_settings DROP COLUMN default_send_account_id', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. `workspace_roles.permissions` : le brouillon d'un modèle de droits abandonné
--    avant la 056 (`capabilities` + `features`), jamais lu.
SET @has_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_roles' AND COLUMN_NAME = 'permissions');
SET @s = IF(@has_col = 1, 'ALTER TABLE workspace_roles DROP COLUMN permissions', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Les quatre noms sans fichier quittent le journal des migrations.
DELETE FROM _migrations WHERE name IN (
    '041_mail_settings_extra.sql',
    '042_mail_sync_interval.sql',
    '043_mail_folder_backfill.sql',
    '044_mail_account_sync_interval.sql'
);

-- 5. Un compte mail « guarded » n'existe plus qu'en espace personnel : dans un
--    espace partagé les deux étages utilisent la clé de l'espace, donc le
--    contenu se relit à l'identique sous « open » et le drapeau se corrige sans
--    rien re-chiffrer. Le serveur refuse désormais ce palier hors espace
--    personnel (`mail/_shared.ts`, `assertTierAllowed`).
UPDATE mail_accounts m
    JOIN workspaces w ON w.id = m.workspace_id
   SET m.security_tier = 'open'
 WHERE w.kind = 'shared' AND m.security_tier = 'guarded';
