-- OSINT : historique des recherches, et clés des fournisseurs optionnels.
--
-- ## Ce qui est chiffré, et pourquoi c'est l'inverse de l'intuition
--
-- Les *résultats* d'une recherche OSINT sont publics par construction — un
-- enregistrement WHOIS, un bloc réseau, un certificat. Ils ne sont donc pas
-- stockés du tout : ils se relisent à la demande et vivent dans un cache mémoire
-- à durée courte (`Services/osint/shared.ts`).
--
-- Ce qui est sensible, c'est **la question posée**. « Qui a cherché ce nom, ce
-- numéro, cette adresse » en dit bien plus long que n'importe laquelle des
-- réponses. `query_enc` passe donc par `ctx.secure` (zero-knowledge, même
-- chemin que les notes et les mots de passe) et le serveur ne le voit jamais en
-- clair.
--
-- `kind` reste en clair : il ne désigne aucune cible, seulement une famille
-- ('domain', 'phone'…), et il permet de grouper et d'icôner la liste sans avoir
-- à ouvrir le coffre — donc sans exiger le mot de passe pour afficher l'écran.

CREATE TABLE IF NOT EXISTS osint_lookups (
    id           CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
    workspace_id INT          NOT NULL,
    user_id      INT          NOT NULL,
    -- Famille de cible : 'domain' | 'ip' | 'url' | 'email' | 'phone' | 'person' | 'username'
    kind         VARCHAR(16)  NOT NULL,
    -- Chiffré via ctx.secure. Jamais lisible côté serveur.
    query_enc    TEXT         NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (id),
    -- L'historique se lit toujours « le plus récent d'abord, pour cet espace ».
    KEY idx_osint_lookup_workspace (workspace_id, created DESC),
    CONSTRAINT fk_osint_lookup_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_osint_lookup_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Clés des fournisseurs optionnels (Pappers, Numverify, HIBP, Shodan,
-- VirusTotal). Calque de `weather_provider_keys` : une clé par (espace,
-- fournisseur), chiffrée par la clé serveur.
--
-- `ctx.crypt` et non `ctx.secure`, délibérément, et pour la même raison que la
-- météo : une clé d'API est un secret **d'installation**, pas un secret
-- d'utilisateur. La passer par le coffre obligerait à réclamer le mot de passe
-- pour exécuter une sonde, ce qui n'a aucun sens pour interroger un registre
-- public.
CREATE TABLE IF NOT EXISTS osint_provider_keys (
    workspace_id INT          NOT NULL,
    provider     VARCHAR(32)  NOT NULL,
    key_enc      TEXT         NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (workspace_id, provider),
    CONSTRAINT fk_osint_key_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
