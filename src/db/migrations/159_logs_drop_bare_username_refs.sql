-- Un echec de connexion garde le condense a cle de l'identifiant saisi, de 32
-- caracteres. Un condense de 16 caracteres est sans cle : quiconque devine ce
-- qui a ete tape le recalcule. Il sort du journal, car rien ne permet de le
-- recalculer sous la cle.
--
-- Rejouable : le condense a cle n'est pas touche.
UPDATE logs
   SET metadata = JSON_REMOVE(metadata, '$.usernameRef')
 WHERE action = 'login.failed'
   AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.usernameRef'))) = 16;
