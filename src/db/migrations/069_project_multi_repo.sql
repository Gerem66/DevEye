-- Un projet peut suivre **plusieurs** dépôts.
--
-- L'invariant « un projet, un dépôt » de la migration 064 était une supposition,
-- pas une contrainte du domaine : un projet réel se compose souvent d'un client,
-- d'un serveur et de contrats partagés, chacun dans son dépôt. La clé primaire
-- sur `project_id` seul rendait cela impossible à exprimer — re-lier remplaçait
-- au lieu d'ajouter.
--
-- La liaison devient donc non exclusive dans les deux sens, exactement comme
-- celle aux bases de données (`project_database_links`, migration 068) et aux
-- services surveillés (`project_uptime_links`, 067). Les trois ont désormais la
-- même forme, ce qui est la forme juste : ce sont des objets d'espace, pas des
-- propriétés d'un projet.
--
-- Les liaisons existantes sont **conservées** : élargir une clé primaire ne perd
-- aucune ligne, chaque `project_id` unique devenant simplement le premier couple
-- de son projet.
--
-- `project_id` reste en tête de la clé composite, ce qui laisse la contrainte
-- `fk_prl_project` s'appuyer dessus comme avant : MySQL exige un index dont
-- `project_id` soit le préfixe, et c'est le cas.
ALTER TABLE project_repo_links
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (project_id, repo_id);
