-- L'horloge d'activité de chaque appareil, le format du manifeste appris, les
-- ports dynamiques repliés par programme, et la fermeture des constats que
-- l'ancienne mesure fabriquait.
--
-- Rejouable : les colonnes sont gardées par INFORMATION_SCHEMA, le repli ignore
-- une clé déjà repliée, et les constats déjà fermés ne bougent plus.

-- Instants évalués depuis toujours : « Programme disparu » compte en instants,
-- une machine éteinte n'avance pas.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'ft_sentinel_device_config'
            AND COLUMN_NAME = 'snapshot_ticks');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_sentinel_device_config
        ADD COLUMN snapshot_ticks BIGINT NOT NULL DEFAULT 0 AFTER last_integrity_at',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Le format du dernier manifeste appris. Un appareil qui en a déjà envoyé un l'a
-- envoyé au format 1. Les autres restent à NULL, et leur premier manifeste
-- s'apprend sans constat.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'ft_sentinel_device_config'
            AND COLUMN_NAME = 'persistence_format');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_sentinel_device_config
        ADD COLUMN persistence_format INT NULL AFTER snapshot_ticks',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE ft_sentinel_device_config
SET persistence_format = 1
WHERE persistence_format IS NULL AND last_integrity_at IS NOT NULL;

-- Une écoute sur un port dynamique (32768 et au-delà) se range sous son
-- programme, `udp/*:dynamique|firefox`, comme le fait `listenerKey`. Sans ce
-- repli, chaque programme déjà connu sonnerait au premier rapport. L'empreinte
-- est celle de `hashKey` (sha256 de la clé).
INSERT INTO device_baseline
    (device_id, kind, item_key, item_hash, first_seen, last_seen, samples, attrs)
SELECT folded.device_id,
       'listener',
       folded.item_key,
       UNHEX(SHA2(folded.item_key, 256)),
       MIN(folded.first_seen),
       MAX(folded.last_seen),
       LEAST(SUM(folded.samples), 4294967295),
       JSON_OBJECT('users', JSON_ARRAY(MAX(folded.program)),
                   'listenPorts', JSON_ARRAY(),
                   'cpuP95', NULL,
                   'memP95', NULL,
                   'sha256', NULL,
                   'surface', MAX(folded.surface),
                   'lastTick', 0,
                   'streak', 0)
FROM (
    SELECT b.device_id,
           CONCAT(SUBSTRING(b.item_key, 1,
                            CHAR_LENGTH(b.item_key) - CHAR_LENGTH(SUBSTRING_INDEX(b.item_key, ':', -1)) - 1),
                  ':dynamique|',
                  COALESCE(u.program, '?')) AS item_key,
           COALESCE(u.program, '?') AS program,
           b.first_seen,
           b.last_seen,
           b.samples,
           JSON_UNQUOTE(JSON_EXTRACT(b.attrs, '$.surface')) AS surface
    FROM device_baseline b
    LEFT JOIN JSON_TABLE(b.attrs, '$.users[*]' COLUMNS (program VARCHAR(128) PATH '$')) AS u ON TRUE
    WHERE b.kind = 'listener'
      AND b.item_key NOT LIKE '%:dynamique|%'
      AND SUBSTRING_INDEX(b.item_key, ':', -1) REGEXP '^[0-9]+$'
      AND CAST(SUBSTRING_INDEX(b.item_key, ':', -1) AS UNSIGNED) >= 32768
) AS folded
GROUP BY folded.device_id, folded.item_key
ON DUPLICATE KEY UPDATE samples = device_baseline.samples;

DELETE FROM device_baseline
WHERE kind = 'listener'
  AND item_key NOT LIKE '%:dynamique|%'
  AND SUBSTRING_INDEX(item_key, ':', -1) REGEXP '^[0-9]+$'
  AND CAST(SUBSTRING_INDEX(item_key, ':', -1) AS UNSIGNED) >= 32768;

-- Les constats que l'ancienne mesure fabriquait, fermés sans autorisation : un
-- vrai cas rouvrira de lui-même. « Programme disparu » comptait en temps réel,
-- un lien `*.wants` était comparé au contenu de sa cible, et Windows hachait
-- d'un bloc des sorties qui changent à chaque exécution d'une tâche.
UPDATE device_findings
SET state = 'resolved', last_seen = UNIX_TIMESTAMP() * 1000
WHERE state = 'open'
  AND (rule = 'process.vanished'
       OR (rule = 'persistence.modified' AND subject LIKE '%.wants/%')
       OR (rule LIKE 'persistence.%' AND (subject = 'schtasks' OR LEFT(subject, 4) IN ('HKLM', 'HKCU'))));
