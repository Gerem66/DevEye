-- Un projet peut suivre plusieurs dépôts : la liaison devient non exclusive dans
-- les deux sens, comme `project_database_links` (068) et `project_uptime_links`
-- (067). Élargir la clé primaire ne perd aucune ligne.
-- `project_id` reste en tête de la clé composite : `fk_prl_project` exige un
-- index dont il soit le préfixe.
ALTER TABLE project_repo_links
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (project_id, repo_id);
