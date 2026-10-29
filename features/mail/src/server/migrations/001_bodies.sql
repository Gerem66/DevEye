-- Le corps déjà analysé des derniers messages d'un dossier (en-têtes, HTML tel
-- que reçu, texte, liste des pièces jointes sans leurs octets), chiffré sous le
-- codec du compte : ce qui rend l'ouverture d'un mail récent immédiate. Un cache
-- en roulement, borné par dossier et dans le temps (sync.ts), relu par BODY.PEEK
-- et donc jamais marqué lu. L'assainissement se fait à la lecture, avec les
-- réglages du lecteur.
--
-- Première table du module au préfixe ft_mail_ : les quatre autres datent du
-- socle et sont dispensées par l'allowlist de deveye-feature.json.

CREATE TABLE IF NOT EXISTS ft_mail_bodies (
    message_id BIGINT     NOT NULL,
    body_enc   MEDIUMTEXT NOT NULL,
    -- Taille de la source RFC822, pour la fiche du message.
    size_bytes INT        NOT NULL,
    -- Secondes epoch : le roulement dans le temps s'y lit.
    fetched_at BIGINT     NOT NULL,
    PRIMARY KEY (message_id),
    KEY idx_ft_mail_bodies_fetched (fetched_at),
    CONSTRAINT fk_ft_mail_bodies_message FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
