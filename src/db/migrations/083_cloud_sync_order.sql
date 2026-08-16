-- Ordre d'affichage des dossiers cloud, défini par l'utilisateur (flèches
-- haut/bas dans la vue CloudSync), comme pour les services surveillés et les
-- notes. Jusqu'ici la liste suivait la date de création, que rien ne permettait
-- de changer.
--
-- Colonne ajoutée conditionnellement via INFORMATION_SCHEMA + SQL dynamique,
-- PAS via `ADD COLUMN IF NOT EXISTS` : cette clause a déjà fait tomber la
-- production au démarrage (non supportée par son serveur MySQL). Le motif
-- ci-dessous ne dépend d'aucun sucre syntaxique récent.
SET @sort_order_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND COLUMN_NAME = 'sort_order'
);
SET @add_sort_order = IF(
    @sort_order_exists = 0,
    'ALTER TABLE sync_shares ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER status',
    'SELECT 1'
);
PREPARE stmt FROM @add_sort_order;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Rang initial = l'ordre de création, numéroté par espace de travail : c'est
-- exactement ce que la liste affichait jusqu'ici (`ORDER BY created ASC, id
-- ASC`), donc rien ne bouge visiblement à la migration. Restreint aux rangs
-- encore à zéro, pour qu'un rejeu ne réécrase pas une disposition déjà choisie.
--
-- `workspace_id` est NULLABLE et `PARTITION BY` regroupe les NULL ensemble, ce
-- qui est le comportement voulu : ces partages forment une seule liste.
UPDATE sync_shares s
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created ASC, id ASC) - 1 AS rn
    FROM sync_shares
) ranked ON ranked.id = s.id
SET s.sort_order = ranked.rn
WHERE s.sort_order = 0;
