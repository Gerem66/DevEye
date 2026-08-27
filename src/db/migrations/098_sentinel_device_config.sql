-- Sentinelle devient un module : ses réglages par appareil quittent la table
-- `devices` (cinq colonnes posées par la 074) pour une table à elle,
-- `ft_sentinel_device_config`, au préfixe des modules.
--
-- C'est le socle qui crée cette table et copie les colonnes, pas une
-- migration du module : au démarrage, les migrations du socle tournent AVANT
-- celles des modules, et une copie faite par le module trouverait des
-- colonnes déjà supprimées. Une seule migration, un seul boot, les deux
-- gestes dans l'ordre. Le module possède la table ensuite (préfixe
-- `ft_sentinel_`, son `uninstall.sql` peut la détruire) ; il n'a rien à rejouer.
--
-- Une ligne par appareil surveillé ou l'ayant été : les appareils qui n'ont
-- jamais eu Sentinelle (colonnes aux défauts) n'en reçoivent pas, l'absence
-- vaut « sondes éteintes ». `ON DELETE CASCADE` : la config meurt avec
-- l'appareil, comme la ligne de base et les constats.
--
-- Rejouable : la copie et la suppression des colonnes sont gardées par la
-- présence de `sentinel_enabled` (voir la 049 pour le patron), donc une base
-- laissée à mi-chemin par un échec se répare en relançant.
--
-- La collation de `device_id` est celle de `devices.id`, lue au moment de
-- créer la table, jamais écrite en dur : une clé étrangère exige que les deux
-- colonnes partagent jeu de caractères et collation, et `devices.id` (004) est
-- un `CHAR(36)` nu qui porte le défaut de la base où il est né (voir la 074).
-- Hériter du défaut courant, comme la 074, ne suffit plus : sur une base
-- restaurée d'un dump, `devices` arrive avec sa collation d'origine épinglée
-- alors que le défaut de la base d'accueil peut être un autre. Lire la
-- collation dans INFORMATION_SCHEMA rend la table juste sur n'importe quel
-- hôte, copie comprise.

SET @cs = (SELECT CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'id');
SET @coll = (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'id');
SET @s = CONCAT(
    'CREATE TABLE IF NOT EXISTS ft_sentinel_device_config (',
    '  device_id CHAR(36) CHARACTER SET ', @cs, ' COLLATE ', @coll, ' NOT NULL,',
    -- Sondes actives ou non ; l'absence de ligne vaut « éteintes ».
    '  enabled TINYINT NOT NULL DEFAULT 0,',
    -- Fin de la fenêtre d'apprentissage, unix ms (voir la 074).
    '  learning_until BIGINT NULL,',
    -- Cadence du manifeste de persistance, en minutes.
    '  integrity_minutes INT NOT NULL DEFAULT 360,',
    -- Le relevé d'authentification, réglable à part.
    '  auth_events TINYINT NOT NULL DEFAULT 1,',
    -- Unix ms du dernier manifeste reçu.
    '  last_integrity_at BIGINT NULL,',
    '  PRIMARY KEY (device_id),',
    '  CONSTRAINT fk_ft_sentinel_device_config_device',
    '    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE',
    ')'
);
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'sentinel_enabled');

SET @s = IF(@c > 0,
    'INSERT INTO ft_sentinel_device_config
        (device_id, enabled, learning_until, integrity_minutes, auth_events, last_integrity_at)
     SELECT id, sentinel_enabled, sentinel_learning_until, sentinel_integrity_minutes,
            sentinel_auth_events, sentinel_last_integrity_at
     FROM devices
     WHERE sentinel_enabled = 1
        OR sentinel_learning_until IS NOT NULL
        OR sentinel_integrity_minutes <> 360
        OR sentinel_auth_events <> 1
        OR sentinel_last_integrity_at IS NOT NULL
     ON DUPLICATE KEY UPDATE
        enabled = VALUES(enabled),
        learning_until = VALUES(learning_until),
        integrity_minutes = VALUES(integrity_minutes),
        auth_events = VALUES(auth_events),
        last_integrity_at = VALUES(last_integrity_at)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@c > 0,
    'ALTER TABLE devices
        DROP COLUMN sentinel_enabled,
        DROP COLUMN sentinel_learning_until,
        DROP COLUMN sentinel_integrity_minutes,
        DROP COLUMN sentinel_auth_events,
        DROP COLUMN sentinel_last_integrity_at',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
