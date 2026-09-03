-- Les retours : la seconde façon dont un site entre dans Audience. La mesure
-- regarde ce que les visiteurs font, un retour est ce qu'ils écrivent, et c'est
-- le site qui décide de sa forme. D'où une charge utile libre, chiffrée en bloc.
--
-- Le chiffrement pose ici le problème qu'il posait aux statistiques, et reçoit
-- la même réponse : rien ne s'agrège sur `content`, et ce sur quoi on compte
-- (le nom d'une question, la valeur d'une réponse) passe par une table de
-- libellés hachés, les compteurs ne portant que des identifiants entiers.
--
-- Premières tables du module au préfixe `ft_audience_` : les sept autres datent
-- du socle (migrations 076 à 079) et sont dispensées par l'allowlist de
-- deveye-feature.json.

-- Le canal nommé qui reçoit les retours d'un site. Il naît de sa première
-- réception : exiger de le déclarer d'abord obligerait à revenir dans
-- l'interface avant de pouvoir tester une intégration, et une faute de frappe y
-- produirait un silence total au lieu d'une ligne visible.
CREATE TABLE IF NOT EXISTS ft_audience_forms (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    site_id     INT      NOT NULL,
    -- 16 premiers caractères du sha256 du nom en minuscules : le chiffrement
    -- étant non déterministe, `content` ne peut pas porter l'unicité.
    name_ref    CHAR(16) NOT NULL,
    -- Fermé, plus rien n'entre. Ce qui est déjà là ne bouge pas.
    is_open     TINYINT  NOT NULL DEFAULT 1,
    -- Dénormalisés : le sommaire et la liste des formulaires les lisent sans
    -- jamais toucher `ft_audience_submissions`, qui est la grosse table.
    submissions INT      NOT NULL DEFAULT 0,
    last_at     BIGINT   NULL,
    sort_order  INT      NOT NULL DEFAULT 0,
    -- { name } chiffré, étage ouvert.
    content     TEXT     NOT NULL,
    created     BIGINT   NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_ft_audience_form (site_id, name_ref),
    KEY idx_ft_audience_forms_site (site_id, sort_order),
    CONSTRAINT fk_ft_audience_form_site FOREIGN KEY (site_id) REFERENCES audience_sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Un retour reçu. Aucune rétention ne le touche : un événement de mesure est
-- jetable, un message ne l'est pas, et l'effacer au bout de N jours perdrait ce
-- que l'utilisateur avait demandé à collecter. Le garde est un plafond par
-- formulaire, qui arrête d'accepter au lieu d'effacer.
CREATE TABLE IF NOT EXISTS ft_audience_submissions (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    form_id    INT        NOT NULL,
    -- Dénormalisé : compter les retours d'un site ne demande pas de jointure.
    site_id    INT        NOT NULL,
    ts         BIGINT     NOT NULL,
    -- La visite d'où vient le retour, quand on a su la retrouver. Elle expire
    -- avec la rétention des sessions, d'où le SET NULL : le retour survit à son
    -- contexte, l'inverse n'aurait aucun sens.
    session_id BIGINT     NULL,
    -- { fields, path } chiffré, en bloc.
    content    MEDIUMTEXT NOT NULL,
    KEY idx_ft_audience_submissions_form (form_id, ts, id),
    KEY idx_ft_audience_submissions_site (site_id, ts),
    KEY idx_ft_audience_submissions_session (session_id),
    CONSTRAINT fk_ft_audience_submission_form FOREIGN KEY (form_id) REFERENCES ft_audience_forms(id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_audience_submission_session FOREIGN KEY (session_id) REFERENCES audience_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Le nom d'une question ou la valeur d'une réponse, chiffré et dédoublonné par
-- son condensé. Même rôle qu'`audience_labels` pour la mesure, mais rattaché au
-- formulaire : deux formulaires d'un même site posent rarement les mêmes
-- questions, et les mélanger ferait des compteurs partagés à tort.
CREATE TABLE IF NOT EXISTS ft_audience_form_labels (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    form_id   INT        NOT NULL,
    -- 'field' | 'value'
    kind      VARCHAR(6) NOT NULL,
    label_ref CHAR(16)   NOT NULL,
    content   TEXT       NOT NULL,
    UNIQUE KEY uniq_ft_audience_form_label (form_id, kind, label_ref),
    CONSTRAINT fk_ft_audience_form_label_form FOREIGN KEY (form_id) REFERENCES ft_audience_forms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Combien de fois cette réponse a été donnée à cette question. Incrémenté à la
-- réception, ce qui rend une répartition lisible sans ouvrir une seule clé.
--
-- `value_id = 0` est le seau « texte libre » : il ne pointe aucun libellé et ne
-- garde qu'un nombre. Un AUTO_INCREMENT commence à 1, la sentinelle ne peut pas
-- entrer en collision avec un vrai identifiant.
CREATE TABLE IF NOT EXISTS ft_audience_answers (
    form_id  INT NOT NULL,
    field_id INT NOT NULL,
    value_id INT NOT NULL,
    hits     INT NOT NULL DEFAULT 0,
    PRIMARY KEY (form_id, field_id, value_id),
    KEY idx_ft_audience_answers_field (form_id, field_id, hits),
    CONSTRAINT fk_ft_audience_answer_form FOREIGN KEY (form_id) REFERENCES ft_audience_forms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
