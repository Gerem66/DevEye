-- Le démontage du module : sa seule table au préfixe, les clés Dokploy (créée
-- et remplie par la 099 du socle, possédée par le module ensuite). Les deux
-- tables historiques (deploy_targets, deployments, migration 080 du socle) sont
-- des données de l'application et restent en place ; la sentinelle du SQL de
-- démontage refuserait de toute façon d'y toucher. `project_deploy_links`
-- appartient à Projets.
DROP TABLE IF EXISTS ft_deploy_credentials;
