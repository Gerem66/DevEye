-- Une rafale de retours écarte la provenance qui l'envoie, elle ne ferme plus
-- le formulaire.
--
-- Le quota horaire toutes adresses confondues mettait `is_open = 0` jusqu'à un
-- geste humain. Or la clé publique du site est en clair dans sa page : qui la
-- lit tenait là de quoi couper le formulaire de contact d'un site pour des
-- jours, sans que personne ne s'en aperçoive avant de constater l'absence de
-- messages. La garde punissait le site pour ce qu'un tiers lui faisait.

-- Les provenances écartées. `ip_ref` est le condensé salé au jour, le même que
-- celui d'un retour : l'adresse n'entre pas plus ici qu'ailleurs.
CREATE TABLE IF NOT EXISTS ft_audience_bans (
    site_id INT      NOT NULL,
    ip_ref  CHAR(16) NOT NULL,
    -- Secondes epoch. Passée, la ligne ne vaut plus rien et le ménage la retire.
    until   BIGINT   NOT NULL,
    PRIMARY KEY (site_id, ip_ref),
    KEY idx_ft_audience_bans_until (until),
    CONSTRAINT fk_ft_audience_bans_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Retours d'une même adresse sur tout le site et par heure, au-delà desquels
-- elle est écartée pour un jour. Bien au-dessus du quota par formulaire, qui
-- écarte l'envoi de qui insiste, là où celui-ci écarte la provenance.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND COLUMN_NAME = 'submission_ban_quota');
SET @s = IF(@c = 0,
    'ALTER TABLE audience_sites ADD COLUMN submission_ban_quota INT NOT NULL DEFAULT 60 AFTER submission_ip_quota',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Ce que l'ancienne garde avait fermé se rouvre : le motif n'existe plus, et
-- laisser ces formulaires clos ferait porter au site une sanction qui ne le
-- visait pas. Rejouable, la condition ne retrouvant plus rien ensuite.
UPDATE ft_audience_forms
   SET is_open = 1, closed_at = NULL, closed_reason = NULL
 WHERE closed_reason = 'quota';
