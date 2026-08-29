-- Seule la table au préfixe du module part. Les tables device_baseline,
-- device_findings et sentinel_allowlist sont des données de l'application et
-- restent en place (la sentinelle du SQL de démontage refuserait d'y toucher).
DROP TABLE IF EXISTS ft_sentinel_device_config;
