-- Seules les tables au préfixe du module partent. Les tables uptime_services,
-- uptime_checks, uptime_daily, uptime_incidents et uptime_settings sont des
-- données de l'application et restent en place.
DROP TABLE IF EXISTS ft_uptime_deploy_sources;
DROP TABLE IF EXISTS ft_uptime_integrity_readings;
DROP TABLE IF EXISTS ft_uptime_page_services;
DROP TABLE IF EXISTS ft_uptime_pages;
