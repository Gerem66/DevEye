-- Le démontage du module : sa seule table au préfixe, les jetons GitHub (créée
-- et remplie par la 100 du socle, possédée par le module ensuite). Les six
-- tables historiques (git_repos, git_branches, git_commits, git_commit_authors,
-- git_pull_requests, git_releases, migration 064 du socle) sont des données de
-- l'application et restent en place ; la sentinelle du SQL de démontage
-- refuserait de toute façon d'y toucher. `project_repo_links` appartient à
-- Projets.
DROP TABLE IF EXISTS ft_git_credentials;
