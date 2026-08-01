-- Ordre des services surveillés entièrement défini par l'utilisateur
-- (glisser-déposer), comme pour les notes.
--
-- Remplace le tri automatique par urgence qui était fait côté client : les deux
-- ne peuvent pas coexister, et un ordre qui se réarrange tout seul sous le
-- curseur n'est pas un ordre. Rien ne touche `sort_order` en dehors de
-- `uptime.reorder` et de l'ajout d'un service (qui prend le rang suivant, donc
-- la fin de la liste).
--
-- Un correctif antérieur avait ajouté cette colonne directement dans
-- 037_uptime.sql une fois celle-ci déjà déployée en production — un no-op sur
-- toute base l'ayant déjà exécutée, puisqu'une migration ne tourne jamais deux
-- fois (voir `src/db/migrate.ts`). 037 a été restaurée à son contenu réellement
-- livré ; cette migration-ci referme l'écart.
--
-- La colonne est ajoutée conditionnellement via INFORMATION_SCHEMA + SQL
-- dynamique, PAS via `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la
-- production au démarrage (erreur de syntaxe — non supportée par son serveur
-- MySQL, malgré la documentation de la version précédente de ce fichier). Le
-- motif ci-dessous ne dépend d'aucun sucre syntaxique récent : introspection +
-- exécution dynamique, portable sur toute version MySQL/MariaDB.
SET @sort_order_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND COLUMN_NAME = 'sort_order'
);
SET @add_sort_order = IF(
    @sort_order_exists = 0,
    'ALTER TABLE uptime_services ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER enabled',
    'SELECT 1'
);
PREPARE stmt FROM @add_sort_order;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Rang initial = l'ordre de création, numéroté par (utilisateur, workspace) :
-- c'est exactement ce que la liste affichait jusqu'ici à état égal, donc rien
-- ne bouge visiblement à la migration. Restreint aux rangs encore à zéro : une
-- base ayant déjà une vraie disposition (glisser-déposer déjà utilisé) n'est
-- pas réécrasée par une renumérotation par date de création.
UPDATE uptime_services s
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id, workspace_id ORDER BY id ASC) - 1 AS rn
    FROM uptime_services
) ranked ON ranked.id = s.id
SET s.sort_order = ranked.rn
WHERE s.sort_order = 0;
