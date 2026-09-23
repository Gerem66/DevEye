-- La consommation mensuelle d'un espace, tenue à part de ses sites.
--
-- Elle se lisait jusqu'ici sur `audience_daily` et `audience_events`, qui
-- pendent tous deux au site et tombent avec lui. Supprimer son site puis le
-- recréer remettait donc le compteur du mois à zéro, et l'offre gratuite
-- n'était plus bornée que par la patience de qui recolle une balise.
--
-- Elle pend à l'espace, seul objet que la limite concerne vraiment : l'offre
-- est celle du propriétaire, et tous ses espaces tirent sur la même réserve.
-- Une ligne par espace et par mois, incrémentée à la vidange de la file, donc
-- une écriture par seconde au pire, jamais une par vue.
CREATE TABLE IF NOT EXISTS ft_audience_usage (
    workspace_id INT    NOT NULL,
    -- AAAAMM en UTC, comme `audience_daily.day` est AAAAMMJJ.
    month        INT    NOT NULL,
    -- Vues et événements nommés confondus : c'est ce que l'offre borne.
    events       BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, month),
    CONSTRAINT fk_ft_audience_usage_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- La reprise du mois en cours, pour qu'aucun compte ne reparte de zéro au
-- déploiement : les jours révolus depuis l'agrégat, aujourd'hui depuis les
-- événements bruts, l'agrégat n'étant refait qu'au ménage horaire.
--
-- Dernière instruction du fichier, et elle remplace au lieu d'ajouter : un
-- échec plus loin ferait rejouer le fichier entier au démarrage suivant, et un
-- `events + VALUES(events)` compterait alors deux fois.
INSERT INTO ft_audience_usage (workspace_id, month, events)
SELECT workspace_id, CAST(DATE_FORMAT(UTC_DATE(), '%Y%m') AS UNSIGNED), SUM(n)
  FROM (
        SELECT s.workspace_id AS workspace_id, COALESCE(SUM(d.events), 0) AS n
          FROM audience_daily d
          JOIN audience_sites s ON s.id = d.site_id
         WHERE d.day >= CAST(DATE_FORMAT(UTC_DATE(), '%Y%m01') AS UNSIGNED)
           AND d.day <  CAST(DATE_FORMAT(UTC_DATE(), '%Y%m%d') AS UNSIGNED)
         GROUP BY s.workspace_id
        UNION ALL
        SELECT s.workspace_id AS workspace_id, COUNT(*) AS n
          FROM audience_events e
          JOIN audience_sites s ON s.id = e.site_id
         WHERE e.ts >= UNIX_TIMESTAMP(UTC_DATE())
         GROUP BY s.workspace_id
       ) AS seen
 GROUP BY workspace_id
ON DUPLICATE KEY UPDATE events = VALUES(events);
