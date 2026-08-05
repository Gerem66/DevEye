-- Cle de donnees propre a un espace partage (WDK).
--
-- Jusqu'ici un espace partage resolvait les cles de son **proprietaire**. C'est
-- ce qui a rendu les migrations 046-053 sures — aucun blob n'a eu besoin d'etre
-- re-chiffre — mais ca plafonne le partage : si le proprietaire a active le
-- chiffrement par mot de passe, lui seul peut lire l'espace, les autres membres
-- voient les lignes sans le contenu.
--
-- La WDK leve ce plafond. Emballee par la cle serveur, comme la BMK de CloudSync
-- et l'etage ouvert (cf. SECURITY_MODEL.md) : le serveur peut la deballer seul,
-- donc tout membre lit l'espace. Contrepartie assumee et documentee — un serveur
-- vivant compromis lit les espaces partages, jamais les espaces personnels, qui
-- gardent leur DEK emballee par mot de passe.
--
-- La table est volontairement vide a la creation. La presence d'une ligne
-- signifie « cet espace utilise sa propre cle » :
--   - un espace partage cree apres cette migration en recoit une aussitot ; il
--     est vide, il n'y a rien a convertir ;
--   - un espace anterieur n'en a pas encore. Sa conversion exige de dechiffrer
--     l'existant avec la cle du proprietaire, donc son mot de passe vivant :
--     aucune migration SQL ne peut le faire. C'est une action explicite du
--     proprietaire (`workspace.enableSharedKey`), session deverrouillee.
--
-- L'absence de ligne est donc un etat transitoire avec une fin claire, pas un
-- mode permanent : une fois les espaces anterieurs convertis, la branche « pas
-- de cle » disparait du code.

CREATE TABLE IF NOT EXISTS workspace_secret_keys (
    workspace_id INT       PRIMARY KEY,
    -- Toujours emballee par la cle serveur : jamais par un mot de passe, sinon
    -- l'espace redeviendrait illisible pour les autres membres.
    dek_wrapped  TEXT      NOT NULL,
    created      BIGINT    NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated      BIGINT    NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    CONSTRAINT fk_workspace_dek FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
