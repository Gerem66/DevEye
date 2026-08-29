-- OSINT : historique des recherches, et clés des fournisseurs optionnels.
--
-- Les résultats sont publics par construction et ne sont pas stockés (cache
-- mémoire court, `Services/osint/shared.ts`). Ce qui est sensible, c'est la
-- question posée : `query_enc` passe par `ctx.secure` (zero-knowledge, même
-- chemin que les notes) et le serveur ne le voit jamais en clair. `kind` reste
-- en clair : il ne désigne aucune cible et permet de grouper la liste sans
-- ouvrir le coffre.

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

-- Clés des fournisseurs optionnels, calque de `weather_provider_keys` : une clé
-- par (espace, fournisseur), chiffrée par la clé serveur (`ctx.crypt`, pas
-- `ctx.secure`). Une clé d'API est un secret d'installation, pas d'utilisateur :
-- réclamer le mot de passe pour interroger un registre public n'a pas de sens.
CREATE TABLE IF NOT EXISTS osint_provider_keys (
    workspace_id INT          NOT NULL,
    provider     VARCHAR(32)  NOT NULL,
    key_enc      TEXT         NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (workspace_id, provider),
    CONSTRAINT fk_osint_key_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
