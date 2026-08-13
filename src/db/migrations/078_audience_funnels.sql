-- Les entonnoirs : ce qui rend lisible « où les gens décrochent ».
--
-- ## Un entonnoir ne collecte rien
--
-- C'est une **lecture** des événements déjà là, jamais une seconde collecte.
-- Le site pose des signaux nommés (`deveye.event('etape-email')`), et les
-- marches se composent ici, après coup. Conséquence directe et voulue : mesurer
-- un autre parcours ne demande aucun redéploiement du site suivi, et supprimer
-- un entonnoir ne perd aucune donnée — le recréer à l'identique rendrait
-- exactement les mêmes chiffres.
--
-- C'est aussi pourquoi ces deux tables sont minuscules et ne grandissent qu'à
-- la main : quelques dizaines de lignes par site, là où `audience_events` en
-- compte des millions.
--
-- ⚠️ Deux colonnes chiffrées de plus à déclarer dans `workspaceRekey`, portée
-- `audience_site` : `audience_funnels.content` et `audience_funnel_steps.content`.

CREATE TABLE IF NOT EXISTS audience_funnels (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    site_id    INT      NOT NULL,
    -- 16 premiers caractères du sha256 du nom en minuscules : porte l'unicité
    -- que `content` chiffré ne peut pas porter. Même motif que partout ailleurs.
    name_ref   CHAR(16) NOT NULL,
    sort_order INT      NOT NULL DEFAULT 0,
    -- { name } chiffré, étage ouvert.
    content    TEXT     NOT NULL,
    created    BIGINT   NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_audience_funnel_name (site_id, name_ref),
    KEY idx_audience_funnels_order (site_id, sort_order),
    CONSTRAINT fk_audience_funnel_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
);

-- Une marche : sa place dans l'ordre, ce qu'elle reconnaît, et son libellé.
--
-- `label_ref` est le **même condensé** que celui d'`audience_labels` : c'est ce
-- qui permet de retrouver l'identifiant du libellé sans jamais déchiffrer pour
-- comparer, et donc de compter en SQL sur des entiers.
--
-- Une marche peut parfaitement ne correspondre à **aucun** libellé : c'est le
-- cas d'un événement qu'on a prévu mais que le site n'a encore jamais posé. Elle
-- compte alors zéro, ce qui est la vérité — et non une erreur à signaler.
--
-- `site_id` est dupliqué depuis l'entonnoir, et c'est délibéré : la requête de
-- rétention joint les marches aux libellés du site, et remonter par
-- `audience_funnels` à chaque fois n'aurait servi qu'à écrire une jointure de
-- plus dans la seule requête du module qu'on veut garder lisible.
CREATE TABLE IF NOT EXISTS audience_funnel_steps (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    funnel_id  INT         NOT NULL,
    site_id    INT         NOT NULL,
    position   INT         NOT NULL,
    -- 'path' | 'event'
    match_kind VARCHAR(12) NOT NULL,
    label_ref  CHAR(16)    NOT NULL,
    -- La valeur lisible, chiffrée : la marche se décrit toute seule, même quand
    -- aucun libellé ne lui correspond encore.
    content    TEXT        NOT NULL,
    UNIQUE KEY uniq_audience_funnel_step (funnel_id, position),
    KEY idx_audience_funnel_steps_site (site_id),
    CONSTRAINT fk_audience_step_funnel FOREIGN KEY (funnel_id) REFERENCES audience_funnels(id) ON DELETE CASCADE,
    CONSTRAINT fk_audience_step_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
);
