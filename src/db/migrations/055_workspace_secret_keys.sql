-- Cle de donnees propre a un espace partage (WDK).
--
-- Un espace partage ne resout pas les cles de son proprietaire : si celui-ci
-- activait le chiffrement par mot de passe, lui seul pourrait lire l'espace.
-- La WDK, emballee par la cle serveur comme la BMK de CloudSync et l'etage
-- ouvert (cf. SECURITY_MODEL.md), est deballable par le serveur seul : tout
-- membre lit l'espace, et les taches de fond y travaillent sans session.
-- Contrepartie assumee et documentee : un serveur vivant compromis lit les
-- espaces partages, jamais les espaces personnels, qui gardent leur DEK
-- emballee par mot de passe.
--
-- Tout espace partage recoit sa ligne a la creation (`workspace.add`) ; un
-- espace partage sans ligne est un invariant rompu, pas un etat.

CREATE TABLE IF NOT EXISTS workspace_secret_keys (
    workspace_id INT       PRIMARY KEY,
    -- Toujours emballee par la cle serveur : jamais par un mot de passe, sinon
    -- l'espace redeviendrait illisible pour les autres membres.
    dek_wrapped  TEXT      NOT NULL,
    created      BIGINT    NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    updated      BIGINT    NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    CONSTRAINT fk_workspace_dek FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
