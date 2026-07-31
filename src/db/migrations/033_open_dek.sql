-- Deuxième clé de données par utilisateur : la « DEK ouverte ».
--
-- La DEK historique (`dek_wrapped`) suit le mode d'emballage choisi par
-- l'utilisateur : quand « Chiffrement par mot de passe » est ON elle n'est
-- déballable qu'avec le mot de passe, ce qui rend TOUTES les données de features
-- inaccessibles sans saisie. Certaines features doivent pourtant s'ouvrir sans
-- prompt (les notes non privées, par exemple) tout en restant chiffrées au repos.
--
-- `open_dek_wrapped` porte donc une seconde DEK aléatoire, distincte, TOUJOURS
-- emballée par la clé serveur : le serveur la déballe seul, sans mot de passe.
-- Elle est créée paresseusement à la première écriture ouverte (NULL avant),
-- comme la DEK principale. Faire tourner CRYPT_KEY_A/B ne demande que de
-- ré-emballer ces 32 octets, jamais de re-chiffrer le contenu.
ALTER TABLE user_secret_keys
    ADD COLUMN open_dek_wrapped TEXT NULL AFTER dek_wrapped;
