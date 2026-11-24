-- La racine des condenses a cle (Services/refKeys.ts) : tiree au sort au premier
-- demarrage et scellee par la cle du serveur. Une seule ligne. Une rotation de
-- CRYPT_KEY_A/B la re-emballe sans changer un seul condense.
CREATE TABLE IF NOT EXISTS server_ref_key (
    id     TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
    sealed TEXT    NOT NULL,
    CONSTRAINT chk_server_ref_key_single CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Un echec de connexion gardait un condense sans cle de l'identifiant saisi, de
-- 16 caracteres, que quiconque recalcule en devinant ce qui a ete tape. Il sort
-- des lignes existantes : rien ne permet de le recalculer sous la cle.
--
-- Rejouable : le condense a cle en compte 32, et n'est pas touche.
UPDATE logs
   SET metadata = JSON_REMOVE(metadata, '$.usernameRef')
 WHERE action = 'login.failed'
   AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.usernameRef'))) = 16;
