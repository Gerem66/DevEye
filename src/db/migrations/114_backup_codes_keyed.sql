-- Les codes de secours passent de 8 à 16 caractères et sont condensés sous une
-- clé dérivée de la clé serveur (HMAC), plus en SHA-256 nu : un dump seul ne
-- permet plus de les deviner hors ligne. Les anciens condensés ne sont pas
-- convertibles (le serveur ne connaît pas les codes) : ils sont effacés, et
-- chaque compte régénère les siens depuis Sécurité (twofa.regenBackup). La
-- double authentification elle-même reste active.
DELETE FROM user_2fa_backup_codes;
