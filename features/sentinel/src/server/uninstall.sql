-- Le démontage du module : sa seule table au préfixe. Les trois tables
-- historiques (device_baseline, device_findings, sentinel_allowlist, migration
-- 074 du socle) sont des données de l'application et restent en place ; la
-- sentinelle du SQL de démontage refuserait de toute façon d'y toucher.
DROP TABLE IF EXISTS ft_sentinel_device_config;
