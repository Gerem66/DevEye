-- Le miroir destructif de la migration, dans l'ordre inverse des cles
-- etrangeres. Idempotent : la desinstallation peut etre rejouee.
DROP TABLE IF EXISTS ft_moderation_hits;
DROP TABLE IF EXISTS ft_moderation_rules;
DROP TABLE IF EXISTS ft_moderation_meta;
