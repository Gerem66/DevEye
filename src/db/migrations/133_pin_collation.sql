-- Epingle la collation du socle. Les tables creees sans COLLATE heritent de
-- celle de la base : utf8mb4_general_ci en production, utf8mb4_0900_ai_ci sur
-- un MySQL 8 neuf, ou deux collations se melent alors et une jointure entre
-- une table epinglee et une autre echoue. Chaque geste est garde par
-- INFORMATION_SCHEMA et ne fait rien la ou c'est deja le cas.
-- Les cles etrangeres texte pointent toutes vers devices.id : les
-- verifications sont suspendues sur cette seule connexion, le temps de
-- convertir la mere puis ses filles.
SET FOREIGN_KEY_CHECKS = 0;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE devices CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Trois tables de modules creees par le socle lui-meme (098, 099, 100), donc
-- avant cette migration.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_sentinel_device_config' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE ft_sentinel_device_config CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE ft_deploy_credentials CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_git_credentials' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE ft_git_credentials CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_migrations' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE _migrations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_daily' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE audience_daily CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_events' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE audience_events CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_funnel_steps' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE audience_funnel_steps CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_funnels' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE audience_funnels CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_labels' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE audience_labels CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sessions' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE audience_sessions CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sites' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE audience_sites CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_alerts' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE database_alerts CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_connections' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE database_connections CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_baseline' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE device_baseline CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_findings' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE device_findings CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_link_codes' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE device_link_codes CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_metrics' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE device_metrics CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_presence' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE device_presence CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_process_samples' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE device_process_samples CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'feature_kv' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE feature_kv CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_branches' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE git_branches CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_commit_authors' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE git_commit_authors CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_commits' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE git_commits CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_pull_requests' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE git_pull_requests CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_releases' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE git_releases CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_repos' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE git_repos CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'logs' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE logs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_accounts' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE mail_accounts CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_folders' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE mail_folders CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_messages' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE mail_messages CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_settings' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE mail_settings CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'note_folders' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE note_folders CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notes' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE notes CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'osint_lookups' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE osint_lookups CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'osint_provider_keys' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE osint_provider_keys CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passwords' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE passwords CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_audience_links' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_audience_links CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_card_deps' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_card_deps CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_card_reads' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_card_reads CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_cards' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_cards CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_columns' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_columns CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_database_links' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_database_links CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_events' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_events CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_messages' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_messages CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_milestones' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_milestones CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_repo_links' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_repo_links CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_uptime_links' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE project_uptime_links CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE projects CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE refresh_tokens CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sentinel_allowlist' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sentinel_allowlist CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_device_files' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_device_files CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_events' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_events CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_exclusions' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_exclusions CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_files' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_files CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_meta' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_meta CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_sessions' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_sessions CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_share_devices' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_share_devices CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shares' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_shares CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_snapshot_files' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_snapshot_files CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_snapshots' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_snapshots CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_versions' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE sync_versions CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_checks' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE uptime_checks CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_daily' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE uptime_daily CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_incidents' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE uptime_incidents CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'uptime_services' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE uptime_services CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_2fa' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE user_2fa CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_2fa_backup_codes' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE user_2fa_backup_codes CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_secret_keys' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE user_secret_keys CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE users CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_locations' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE weather_locations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_provider_keys' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE weather_provider_keys CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE workspace_members CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_roles' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE workspace_roles CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_secret_keys' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE workspace_secret_keys CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND TABLE_COLLATION <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE workspaces CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les colonnes alignees sur devices.id dans des tables deja epinglees.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_destinations' AND COLUMN_NAME = 'device_id'
            AND COLLATION_NAME <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE backup_destinations MODIFY COLUMN device_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deploy_targets' AND COLUMN_NAME = 'device_id'
            AND COLLATION_NAME <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE deploy_targets MODIFY COLUMN device_id CHAR(36) COLLATE utf8mb4_general_ci DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_role_grants' AND COLUMN_NAME = 'item_id'
            AND COLLATION_NAME <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE item_role_grants MODIFY COLUMN item_id VARCHAR(64) COLLATE utf8mb4_general_ci NOT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'item_shares' AND COLUMN_NAME = 'item_id'
            AND COLLATION_NAME <> 'utf8mb4_general_ci');
SET @s = IF(@c = 1, 'ALTER TABLE item_shares MODIFY COLUMN item_id VARCHAR(64) COLLATE utf8mb4_general_ci NOT NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Le defaut de la base elle-meme, sans nom donc la base courante : une table
-- qu'un module creerait sans COLLATE en herite, quelle que soit la base qui
-- accueille DevEye. ALTER DATABASE refuse le protocole prepare, d'ou l'absence
-- de garde : poser la valeur deja en place ne change rien.
ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

SET FOREIGN_KEY_CHECKS = 1;
