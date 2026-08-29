-- Le démontage du module : sa seule table au préfixe. deploy_targets et
-- deployments sont des tables du socle et restent en place (la sentinelle du
-- SQL de démontage refuserait d'y toucher). project_deploy_links est à Projets.
DROP TABLE IF EXISTS ft_deploy_credentials;
