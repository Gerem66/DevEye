-- Deuxième clé de données par utilisateur : la « DEK ouverte ».
--
-- `open_dek_wrapped` porte une seconde DEK aléatoire, TOUJOURS emballée par la
-- clé serveur : le serveur la déballe seul, sans mot de passe. Elle sert aux
-- features qui doivent s'ouvrir sans prompt (les notes non privées, par exemple)
-- tout en restant chiffrées au repos, là où `dek_wrapped` devient inaccessible
-- sans saisie quand « Chiffrement par mot de passe » est ON.
-- Créée paresseusement à la première écriture ouverte (NULL avant). Faire
-- tourner CRYPT_KEY_A/B ne demande que de ré-emballer ces 32 octets.
ALTER TABLE user_secret_keys
    ADD COLUMN open_dek_wrapped TEXT NULL AFTER dek_wrapped;
