-- Schéma du socle, généré par `npm run gen:db-schema` depuis une base migrée. Ne pas éditer.

CREATE TABLE `_migrations` (
  `name` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `applied_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `audience_daily` (
  `site_id` int NOT NULL,
  `day` int NOT NULL,
  `views` int NOT NULL DEFAULT '0',
  `events` int NOT NULL DEFAULT '0',
  `sessions` int NOT NULL DEFAULT '0',
  `visitors` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`site_id`,`day`),
  CONSTRAINT `fk_audience_daily_site` FOREIGN KEY (`site_id`) REFERENCES `audience_sites` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `audience_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `site_id` int NOT NULL,
  `session_id` bigint NOT NULL,
  `ts` bigint NOT NULL,
  `kind` tinyint NOT NULL DEFAULT '0',
  `path_id` int DEFAULT NULL,
  `name_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_audience_events_window` (`site_id`,`ts`,`kind`,`path_id`,`name_id`),
  KEY `idx_audience_events_session` (`session_id`),
  KEY `idx_audience_events_funnel` (`site_id`,`ts`,`session_id`),
  CONSTRAINT `fk_audience_event_session` FOREIGN KEY (`session_id`) REFERENCES `audience_sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_audience_event_site` FOREIGN KEY (`site_id`) REFERENCES `audience_sites` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `audience_funnel_steps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `funnel_id` int NOT NULL,
  `site_id` int NOT NULL,
  `position` int NOT NULL,
  `match_kind` varchar(12) COLLATE utf8mb4_general_ci NOT NULL,
  `label_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_audience_funnel_step` (`funnel_id`,`position`),
  KEY `idx_audience_funnel_steps_site` (`site_id`),
  CONSTRAINT `fk_audience_step_funnel` FOREIGN KEY (`funnel_id`) REFERENCES `audience_funnels` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_audience_step_site` FOREIGN KEY (`site_id`) REFERENCES `audience_sites` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `audience_funnels` (
  `id` int NOT NULL AUTO_INCREMENT,
  `site_id` int NOT NULL,
  `name_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_audience_funnel_name` (`site_id`,`name_ref`),
  KEY `idx_audience_funnels_order` (`site_id`,`sort_order`),
  CONSTRAINT `fk_audience_funnel_site` FOREIGN KEY (`site_id`) REFERENCES `audience_sites` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `audience_labels` (
  `id` int NOT NULL AUTO_INCREMENT,
  `site_id` int NOT NULL,
  `kind` varchar(12) COLLATE utf8mb4_general_ci NOT NULL,
  `label_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_audience_label` (`site_id`,`kind`,`label_ref`),
  CONSTRAINT `fk_audience_label_site` FOREIGN KEY (`site_id`) REFERENCES `audience_sites` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `audience_sessions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `site_id` int NOT NULL,
  `visitor_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `started_at` bigint NOT NULL,
  `last_at` bigint NOT NULL,
  `views` int NOT NULL DEFAULT '0',
  `entry_path_id` int DEFAULT NULL,
  `referrer_id` int DEFAULT NULL,
  `browser_id` int DEFAULT NULL,
  `os_id` int DEFAULT NULL,
  `device_id` int DEFAULT NULL,
  `timezone_id` int DEFAULT NULL,
  `language_id` int DEFAULT NULL,
  `identity_id` int DEFAULT NULL,
  `tz_offset` smallint DEFAULT NULL,
  `screen_width` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_audience_sessions_window` (`site_id`,`started_at`,`visitor_ref`),
  KEY `idx_audience_sessions_recent` (`site_id`,`visitor_ref`,`last_at`),
  KEY `idx_audience_sessions_last` (`site_id`,`last_at`),
  KEY `idx_audience_sessions_visitors` (`site_id`,`last_at`,`visitor_ref`),
  CONSTRAINT `fk_audience_session_site` FOREIGN KEY (`site_id`) REFERENCES `audience_sites` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `audience_sites` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `public_key` char(27) COLLATE utf8mb4_general_ci NOT NULL,
  `name_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `platform` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'web',
  `visitor_mode` varchar(12) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'anonymous',
  `origins` text COLLATE utf8mb4_general_ci,
  `active` tinyint NOT NULL DEFAULT '1',
  `retention_days` int NOT NULL DEFAULT '180',
  `forms_auto` tinyint NOT NULL DEFAULT '0',
  `submission_ip_quota` int NOT NULL DEFAULT '5',
  `submission_ban_quota` int NOT NULL DEFAULT '60',
  `form_hourly_quota` int NOT NULL DEFAULT '200',
  `event_ip_quota` int NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `last_event_at` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_audience_site_key` (`public_key`),
  UNIQUE KEY `uniq_audience_site_name` (`workspace_id`,`name_ref`),
  KEY `idx_audience_sites_order` (`workspace_id`,`sort_order`),
  CONSTRAINT `fk_audience_site_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `backup_destinations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `device_id` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `path_style` tinyint NOT NULL DEFAULT '1',
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'unknown',
  `checked_at` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `secret_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_backup_destinations_workspace` (`workspace_id`),
  KEY `idx_backup_destinations_device` (`device_id`),
  CONSTRAINT `fk_bkp_dest_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_bkp_dest_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `backup_jobs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `destination_id` int NOT NULL,
  `source_kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `source_id` int DEFAULT NULL,
  `enabled` tinyint NOT NULL DEFAULT '1',
  `schedule_kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'daily',
  `schedule_hour` tinyint NOT NULL DEFAULT '3',
  `schedule_weekday` tinyint NOT NULL DEFAULT '0',
  `schedule_day` tinyint NOT NULL DEFAULT '1',
  `keep_last` smallint NOT NULL DEFAULT '7',
  `encryption` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'server',
  `next_run_at` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_backup_jobs_workspace` (`workspace_id`),
  KEY `idx_backup_jobs_due` (`next_run_at`),
  KEY `idx_backup_jobs_destination` (`destination_id`),
  CONSTRAINT `fk_bkp_job_destination` FOREIGN KEY (`destination_id`) REFERENCES `backup_destinations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bkp_job_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `backup_runs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `job_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'running',
  `started_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `finished_at` bigint DEFAULT NULL,
  `size_bytes` bigint NOT NULL DEFAULT '0',
  `checksum` char(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `encrypted` tinyint NOT NULL DEFAULT '0',
  `triggered_by_user_id` int DEFAULT NULL,
  `pruned` tinyint NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_backup_runs_job` (`job_id`,`started_at`),
  KEY `idx_backup_runs_workspace` (`workspace_id`,`started_at`),
  KEY `idx_backup_runs_keep` (`job_id`,`status`,`pruned`,`started_at`),
  KEY `fk_bkp_run_user` (`triggered_by_user_id`),
  CONSTRAINT `fk_bkp_run_job` FOREIGN KEY (`job_id`) REFERENCES `backup_jobs` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bkp_run_user` FOREIGN KEY (`triggered_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_bkp_run_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `database_alerts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `database_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `enabled` tinyint NOT NULL DEFAULT '1',
  `combinator` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'and',
  `firing` tinyint NOT NULL DEFAULT '0',
  `last_check_at` bigint DEFAULT NULL,
  `last_fired_at` bigint DEFAULT NULL,
  `last_error` text COLLATE utf8mb4_general_ci,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_database_alerts_db` (`database_id`),
  KEY `fk_database_alert_workspace` (`workspace_id`),
  CONSTRAINT `fk_database_alert_db` FOREIGN KEY (`database_id`) REFERENCES `database_connections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_database_alert_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `database_connections` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `engine` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'mysql',
  `name_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `monitor_enabled` tinyint NOT NULL DEFAULT '0',
  `interval_seconds` int NOT NULL DEFAULT '300',
  `last_check_at` bigint DEFAULT NULL,
  `last_elapsed_ms` int DEFAULT NULL,
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'unknown',
  `last_error` text COLLATE utf8mb4_general_ci,
  `server_version` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `size_bytes` bigint DEFAULT NULL,
  `table_count` int DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `secret_enc` text COLLATE utf8mb4_general_ci,
  `access_content` text COLLATE utf8mb4_general_ci,
  `access_secret_enc` text COLLATE utf8mb4_general_ci,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_database_name` (`workspace_id`,`name_ref`),
  KEY `idx_database_connections_due` (`monitor_enabled`,`last_check_at`),
  CONSTRAINT `fk_database_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `debug_runs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `origin` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `kind` enum('e2e','bench') COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('running','passed','failed','aborted') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'running',
  `started` bigint NOT NULL,
  `finished` bigint DEFAULT NULL,
  `user_id` int DEFAULT NULL,
  `report` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_debug_runs_origin_kind` (`origin`,`kind`,`id`),
  KEY `fk_debug_runs_user` (`user_id`),
  CONSTRAINT `fk_debug_runs_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `deploy_targets` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `credential_id` int DEFAULT NULL,
  `device_id` char(36) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `provider` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'dokploy',
  `target_kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'application',
  `external_id` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `synced_at` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_deploy_target` (`workspace_id`,`credential_id`,`external_id`),
  UNIQUE KEY `uniq_deploy_target_device` (`workspace_id`,`device_id`,`external_id`),
  KEY `fk_deploy_target_credential` (`credential_id`),
  KEY `fk_deploy_target_device` (`device_id`),
  CONSTRAINT `fk_deploy_target_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_deploy_target_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `deployments` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `target_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `external_id` varchar(128) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'queued',
  `triggered_by_user_id` int DEFAULT NULL,
  `started_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `finished_at` bigint DEFAULT NULL,
  `notified` tinyint NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_deployments_time` (`target_id`,`started_at`),
  KEY `idx_deployments_status` (`status`,`started_at`),
  KEY `fk_deployments_workspace` (`workspace_id`),
  KEY `fk_deployments_user` (`triggered_by_user_id`),
  KEY `idx_deployments_external` (`target_id`,`external_id`),
  CONSTRAINT `fk_deployments_target` FOREIGN KEY (`target_id`) REFERENCES `deploy_targets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_deployments_user` FOREIGN KEY (`triggered_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_deployments_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_baseline` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(24) COLLATE utf8mb4_general_ci NOT NULL,
  `item_key` varchar(512) COLLATE utf8mb4_general_ci NOT NULL,
  `item_hash` binary(32) NOT NULL,
  `first_seen` bigint NOT NULL,
  `last_seen` bigint NOT NULL,
  `samples` int unsigned NOT NULL DEFAULT '1',
  `attrs` json NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_baseline_item` (`device_id`,`kind`,`item_hash`),
  KEY `idx_baseline_seen` (`device_id`,`kind`,`last_seen`),
  CONSTRAINT `fk_baseline_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_findings` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `rule` varchar(48) COLLATE utf8mb4_general_ci NOT NULL,
  `dedup_hash` binary(32) NOT NULL,
  `severity` tinyint NOT NULL,
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'open',
  `subject` varchar(512) COLLATE utf8mb4_general_ci NOT NULL,
  `evidence` json NOT NULL,
  `snapshot_ts` bigint DEFAULT NULL,
  `first_seen` bigint NOT NULL,
  `last_seen` bigint NOT NULL,
  `occurrences` int unsigned NOT NULL DEFAULT '1',
  `notified` tinyint NOT NULL DEFAULT '0',
  `acked_by` int DEFAULT NULL,
  `acked_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finding_dedup` (`device_id`,`dedup_hash`),
  KEY `idx_finding_open` (`device_id`,`state`,`severity`),
  KEY `idx_finding_prune` (`state`,`last_seen`),
  KEY `fk_finding_acked_by` (`acked_by`),
  CONSTRAINT `fk_finding_acked_by` FOREIGN KEY (`acked_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_finding_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_link_codes` (
  `code` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `expires_at` bigint NOT NULL,
  `max_uses` int NOT NULL DEFAULT '1',
  `uses` int NOT NULL DEFAULT '0',
  `used_at` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`code`),
  KEY `idx_link_codes_user` (`user_id`),
  KEY `fk_linkcode_workspace` (`workspace_id`),
  CONSTRAINT `fk_linkcode_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_linkcode_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_metrics` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `ts` bigint NOT NULL,
  `cpu_percent` float NOT NULL,
  `mem_used_bytes` bigint NOT NULL,
  `mem_total_bytes` bigint NOT NULL,
  `disk_used_bytes` bigint NOT NULL,
  `disk_total_bytes` bigint NOT NULL,
  `net_rx_bytes` bigint NOT NULL,
  `net_tx_bytes` bigint NOT NULL,
  `users_count` int NOT NULL,
  `load_avg_1` float DEFAULT NULL,
  `cpu_temp_c` float DEFAULT NULL,
  `uptime_seconds` bigint DEFAULT NULL,
  `process_count` int DEFAULT NULL,
  `active_connections` int DEFAULT NULL,
  `gpu_percent` float DEFAULT NULL,
  `disk_read_bytes` bigint DEFAULT NULL,
  `disk_write_bytes` bigint DEFAULT NULL,
  `battery_percent` float DEFAULT NULL,
  `battery_charging` tinyint DEFAULT NULL,
  `pinned` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_metrics_device_ts` (`device_id`,`ts`),
  KEY `idx_metrics_prune` (`pinned`,`ts`),
  KEY `idx_metrics_device_pinned_ts` (`device_id`,`pinned`,`ts`),
  CONSTRAINT `fk_metrics_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_presence` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `ts` bigint NOT NULL,
  `online` tinyint NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_presence_device_ts` (`device_id`,`ts`),
  KEY `idx_presence_ts` (`ts`),
  CONSTRAINT `fk_presence_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `device_process_samples` (
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `ts` bigint NOT NULL,
  `kind` enum('top','all') COLLATE utf8mb4_general_ci NOT NULL,
  `proc_count` int unsigned NOT NULL,
  `payload_bytes` int unsigned NOT NULL,
  `payload` mediumblob NOT NULL,
  `pinned` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`device_id`,`ts`),
  KEY `idx_procsamples_pinned` (`device_id`,`pinned`,`ts`),
  KEY `idx_procsamples_prune` (`pinned`,`ts`),
  KEY `idx_procsamples_thin` (`kind`,`pinned`,`ts`),
  CONSTRAINT `fk_procsamples_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `devices` (
  `id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `owner_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `name` varchar(128) COLLATE utf8mb4_general_ci NOT NULL,
  `fingerprint` varchar(128) COLLATE utf8mb4_general_ci NOT NULL,
  `platform` varchar(32) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'linux',
  `status` varchar(20) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',
  `token_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `token_hash_prev` char(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `last_seen` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `report_json` text COLLATE utf8mb4_general_ci,
  `retention_days` int DEFAULT NULL,
  `terminal_default_user` varchar(32) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `terminal_close_on_exit` tinyint NOT NULL DEFAULT '1',
  `metric_interval_seconds` int DEFAULT NULL,
  `process_capture` enum('off','top','all') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status_before_delete` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `delete_error` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `agent_version` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `agent_target` varchar(32) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_workspace_fingerprint` (`workspace_id`,`fingerprint`),
  KEY `idx_devices_owner` (`owner_id`),
  KEY `idx_devices_status` (`status`),
  KEY `idx_devices_workspace` (`workspace_id`),
  CONSTRAINT `fk_device_owner` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_device_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `feature_domains` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `feature` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `host` varchar(253) COLLATE utf8mb4_general_ci NOT NULL,
  `token` char(32) COLLATE utf8mb4_general_ci NOT NULL,
  `dns_state` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',
  `dns_error` varchar(255) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `probe_state` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',
  `probe_error` varchar(255) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `verified_at` bigint DEFAULT NULL,
  `checked_at` bigint DEFAULT NULL,
  `failures` int NOT NULL DEFAULT '0',
  `next_probe_at` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_feature_domains_host` (`feature`,`host`),
  KEY `idx_feature_domains_ws` (`workspace_id`,`feature`),
  KEY `idx_feature_domains_due` (`next_probe_at`),
  CONSTRAINT `fk_feature_domains_ws` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `feature_kv` (
  `workspace_id` int NOT NULL,
  `feature` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `k` varchar(128) COLLATE utf8mb4_general_ci NOT NULL,
  `mode` enum('server','private','none') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'server',
  `value` mediumtext COLLATE utf8mb4_general_ci NOT NULL,
  `updated` bigint NOT NULL,
  PRIMARY KEY (`workspace_id`,`feature`,`k`),
  CONSTRAINT `fk_feature_kv_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `feature_maintenance` (
  `feature` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `level` enum('requests','full','preview') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'requests',
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_by` int DEFAULT NULL,
  PRIMARY KEY (`feature`),
  KEY `fk_feature_maintenance_user` (`updated_by`),
  CONSTRAINT `fk_feature_maintenance_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `feedback` (
  `id` int NOT NULL AUTO_INCREMENT,
  `uid` int NOT NULL,
  `workspace_id` int DEFAULT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `message` text COLLATE utf8mb4_general_ci NOT NULL,
  `snapshot` json DEFAULT NULL,
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'new',
  `ip` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `app_version` varchar(32) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `handled_at` bigint DEFAULT NULL,
  `handled_by` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_feedback_created` (`created`),
  KEY `idx_feedback_uid_created` (`uid`,`created`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `finance_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'checking',
  `color` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'blue',
  `initial_balance` bigint NOT NULL DEFAULT '0',
  `opened_on` date NOT NULL,
  `archived` tinyint NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_finance_accounts_ws` (`workspace_id`,`archived`,`sort_order`),
  CONSTRAINT `fk_fin_account_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `finance_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `flow` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'expense',
  `color` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'blue',
  `icon` varchar(40) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'other',
  `role` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_finance_categories_ws` (`workspace_id`,`flow`,`sort_order`),
  CONSTRAINT `fk_fin_category_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `finance_config` (
  `workspace_id` int NOT NULL,
  `invoicing_account_id` int DEFAULT NULL,
  `invoicing_category_id` int DEFAULT NULL,
  `invoicing_version` varchar(120) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `legal_status` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `micro_activity` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `provision_rate_bp` int DEFAULT NULL,
  `income_tax_prepaid` tinyint NOT NULL DEFAULT '0',
  `declaration_period` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tracking_since` date DEFAULT NULL,
  PRIMARY KEY (`workspace_id`),
  KEY `fk_fin_config_inv_account` (`invoicing_account_id`),
  KEY `fk_fin_config_inv_category` (`invoicing_category_id`),
  CONSTRAINT `fk_fin_config_inv_account` FOREIGN KEY (`invoicing_account_id`) REFERENCES `finance_accounts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fin_config_inv_category` FOREIGN KEY (`invoicing_category_id`) REFERENCES `finance_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fin_config_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `finance_recurring` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `account_id` int NOT NULL,
  `transfer_account_id` int DEFAULT NULL,
  `category_id` int DEFAULT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'expense',
  `amount` bigint NOT NULL DEFAULT '0',
  `vat_amount` bigint DEFAULT NULL,
  `frequency` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'monthly',
  `interval_count` int NOT NULL DEFAULT '1',
  `next_date` date NOT NULL,
  `anchor_day` tinyint DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `last_posted_date` date DEFAULT NULL,
  `automatic` tinyint NOT NULL DEFAULT '0',
  `active` tinyint NOT NULL DEFAULT '1',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_finance_recurring_due` (`workspace_id`,`active`,`next_date`),
  KEY `fk_fin_recurring_account` (`account_id`),
  KEY `fk_fin_recurring_transfer` (`transfer_account_id`),
  KEY `fk_fin_recurring_category` (`category_id`),
  CONSTRAINT `fk_fin_recurring_account` FOREIGN KEY (`account_id`) REFERENCES `finance_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fin_recurring_category` FOREIGN KEY (`category_id`) REFERENCES `finance_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fin_recurring_transfer` FOREIGN KEY (`transfer_account_id`) REFERENCES `finance_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fin_recurring_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `finance_transactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `account_id` int NOT NULL,
  `transfer_account_id` int DEFAULT NULL,
  `category_id` int DEFAULT NULL,
  `recurring_id` int DEFAULT NULL,
  `source` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `source_ref` varchar(40) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'expense',
  `amount` bigint NOT NULL DEFAULT '0',
  `vat_amount` bigint DEFAULT NULL,
  `date` date NOT NULL,
  `cleared` tinyint NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_finance_tx_occurrence` (`recurring_id`,`date`),
  UNIQUE KEY `uniq_finance_tx_source` (`workspace_id`,`source`,`source_ref`),
  KEY `idx_finance_tx_ws_date` (`workspace_id`,`date`,`id`),
  KEY `idx_finance_tx_account` (`account_id`,`date`),
  KEY `idx_finance_tx_transfer` (`transfer_account_id`,`date`),
  KEY `idx_finance_tx_category` (`category_id`,`date`),
  CONSTRAINT `fk_fin_tx_account` FOREIGN KEY (`account_id`) REFERENCES `finance_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fin_tx_category` FOREIGN KEY (`category_id`) REFERENCES `finance_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fin_tx_recurring` FOREIGN KEY (`recurring_id`) REFERENCES `finance_recurring` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fin_tx_transfer` FOREIGN KEY (`transfer_account_id`) REFERENCES `finance_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fin_tx_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `git_branches` (
  `id` int NOT NULL AUTO_INCREMENT,
  `repo_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `name_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `head_sha` char(40) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ahead_count` int DEFAULT NULL,
  `behind_count` int DEFAULT NULL,
  `compared_sha` varchar(96) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `is_default` tinyint NOT NULL DEFAULT '0',
  `updated_at` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_git_branch` (`repo_id`,`name_ref`),
  KEY `fk_git_branch_workspace` (`workspace_id`),
  CONSTRAINT `fk_git_branch_repo` FOREIGN KEY (`repo_id`) REFERENCES `git_repos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_git_branch_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `git_commit_authors` (
  `id` int NOT NULL AUTO_INCREMENT,
  `repo_id` int NOT NULL,
  `author_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `workspace_id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_git_author` (`repo_id`,`author_ref`),
  KEY `fk_git_author_workspace` (`workspace_id`),
  KEY `fk_git_author_user` (`user_id`),
  CONSTRAINT `fk_git_author_repo` FOREIGN KEY (`repo_id`) REFERENCES `git_repos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_git_author_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_git_author_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `git_commits` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `repo_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `sha` char(40) COLLATE utf8mb4_general_ci NOT NULL,
  `committed_at` bigint NOT NULL,
  `author_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `parents` json DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_git_commit` (`repo_id`,`sha`),
  KEY `idx_git_commits_time` (`repo_id`,`committed_at`),
  KEY `fk_git_commit_workspace` (`workspace_id`),
  CONSTRAINT `fk_git_commit_repo` FOREIGN KEY (`repo_id`) REFERENCES `git_repos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_git_commit_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `git_pull_requests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `repo_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `number` int NOT NULL,
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'open',
  `author_ref` char(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  `merged_at` bigint DEFAULT NULL,
  `closed_at` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_git_pull` (`repo_id`,`number`),
  KEY `idx_git_pulls_time` (`repo_id`,`updated_at`),
  KEY `fk_git_pull_workspace` (`workspace_id`),
  CONSTRAINT `fk_git_pull_repo` FOREIGN KEY (`repo_id`) REFERENCES `git_repos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_git_pull_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `git_releases` (
  `id` int NOT NULL AUTO_INCREMENT,
  `repo_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `tag_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `published_at` bigint NOT NULL,
  `is_prerelease` tinyint NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_git_release` (`repo_id`,`tag_ref`),
  KEY `idx_git_releases_time` (`repo_id`,`published_at`),
  KEY `fk_git_release_workspace` (`workspace_id`),
  CONSTRAINT `fk_git_release_repo` FOREIGN KEY (`repo_id`) REFERENCES `git_repos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_git_release_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `git_repos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `credential_id` int DEFAULT NULL,
  `provider` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'github',
  `slug_ref` char(16) COLLATE utf8mb4_general_ci NOT NULL,
  `enabled` tinyint NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `default_branch` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `last_sync_at` bigint DEFAULT NULL,
  `last_sync_error` text COLLATE utf8mb4_general_ci,
  `sync_state` text COLLATE utf8mb4_general_ci,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_git_repo` (`workspace_id`,`slug_ref`),
  KEY `idx_git_repos_due` (`enabled`,`last_sync_at`),
  KEY `fk_git_repo_credential` (`credential_id`),
  CONSTRAINT `fk_git_repo_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `instance_settings` (
  `name` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `origin` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `value` text COLLATE utf8mb4_general_ci NOT NULL,
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_by` int DEFAULT NULL,
  PRIMARY KEY (`name`,`origin`),
  KEY `fk_instance_settings_user` (`updated_by`),
  CONSTRAINT `fk_instance_settings_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `item_role_grants` (
  `workspace_id` int NOT NULL,
  `feature` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `item_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `role_id` int NOT NULL,
  `access` varchar(8) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `extra_overrides` json DEFAULT NULL,
  PRIMARY KEY (`workspace_id`,`feature`,`item_id`,`role_id`),
  KEY `idx_item_grants_role` (`role_id`),
  CONSTRAINT `fk_item_grant_role` FOREIGN KEY (`role_id`) REFERENCES `workspace_roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_item_grant_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `item_shares` (
  `workspace_id` int NOT NULL,
  `feature` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `item_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `home_workspace_id` int NOT NULL,
  `shared_by_user_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`workspace_id`,`feature`,`item_id`),
  KEY `idx_item_shares_home` (`home_workspace_id`,`feature`,`item_id`),
  KEY `fk_item_share_user` (`shared_by_user_id`),
  CONSTRAINT `fk_item_share_home` FOREIGN KEY (`home_workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_item_share_user` FOREIGN KEY (`shared_by_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_item_share_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `uid` int NOT NULL DEFAULT '0',
  `ip` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `source` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'system',
  `category` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `level` int NOT NULL DEFAULT '0',
  `action` varchar(64) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `description` text COLLATE utf8mb4_general_ci NOT NULL,
  `metadata` json DEFAULT NULL,
  `date` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_logs_uid` (`uid`),
  KEY `idx_logs_date` (`date`),
  KEY `idx_logs_source` (`source`),
  KEY `idx_logs_category` (`category`),
  KEY `idx_logs_action` (`action`),
  KEY `idx_logs_level` (`level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `mail_accounts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `display_name_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `email_address_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `security_tier` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'open',
  `auth_method` varchar(20) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'password',
  `enabled` tinyint NOT NULL DEFAULT '1',
  `sync_interval_seconds` int NOT NULL DEFAULT '600',
  `last_sync_at` bigint DEFAULT NULL,
  `last_sync_status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'ok',
  `last_error_at` bigint DEFAULT NULL,
  `last_sync_error_enc` text COLLATE utf8mb4_general_ci,
  `credentials_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_mail_accounts_user` (`user_id`),
  KEY `idx_mail_accounts_sync_due` (`enabled`,`security_tier`,`last_sync_at`),
  KEY `idx_mail_accounts_workspace` (`workspace_id`),
  CONSTRAINT `fk_mail_account_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mail_account_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `mail_folders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `account_id` int NOT NULL,
  `imap_path` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `name_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `special_use` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'other',
  `sort_order` int NOT NULL DEFAULT '0',
  `uid_validity` bigint DEFAULT NULL,
  `last_seen_uid` bigint DEFAULT NULL,
  `first_seen_uid` bigint DEFAULT NULL,
  `unread_count` int NOT NULL DEFAULT '0',
  `total_count` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_mail_folders_account` (`account_id`),
  CONSTRAINT `fk_mail_folder_account` FOREIGN KEY (`account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `mail_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `folder_id` int NOT NULL,
  `uid` bigint NOT NULL,
  `envelope_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `date` bigint NOT NULL,
  `seen` tinyint NOT NULL DEFAULT '0',
  `flagged` tinyint NOT NULL DEFAULT '0',
  `answered` tinyint NOT NULL DEFAULT '0',
  `has_attachments` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mail_messages_folder_uid` (`folder_id`,`uid`),
  KEY `idx_mail_messages_folder_date` (`folder_id`,`date`),
  CONSTRAINT `fk_mail_message_folder` FOREIGN KEY (`folder_id`) REFERENCES `mail_folders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `mail_settings` (
  `workspace_id` int NOT NULL,
  `external_scan_enabled_default` tinyint NOT NULL DEFAULT '0',
  `trusted_image_domains` text COLLATE utf8mb4_general_ci,
  `body_render_mode` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'embedded',
  PRIMARY KEY (`workspace_id`),
  CONSTRAINT `fk_mail_settings_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `note_folders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_note_folders_user` (`user_id`),
  KEY `idx_note_folders_workspace` (`workspace_id`),
  CONSTRAINT `fk_note_folder_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_note_folder_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `notes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `folder_id` int DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `is_private` tinyint NOT NULL DEFAULT '0',
  `archived_at` bigint DEFAULT NULL,
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_notes_user` (`user_id`),
  KEY `idx_notes_workspace` (`workspace_id`),
  KEY `idx_notes_folder` (`folder_id`),
  KEY `idx_notes_archived` (`user_id`,`archived_at`),
  CONSTRAINT `fk_note_folder` FOREIGN KEY (`folder_id`) REFERENCES `note_folders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_note_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_note_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `notification_channels` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `feature` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `label_enc` text COLLATE utf8mb4_general_ci,
  `target_enc` text COLLATE utf8mb4_general_ci,
  `mail_account_id` int DEFAULT NULL,
  `enabled` tinyint NOT NULL DEFAULT '1',
  `position` int NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_notif_channels_ws_feature` (`workspace_id`,`feature`,`position`),
  CONSTRAINT `fk_notif_channel_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `notification_route_channels` (
  `route_id` int NOT NULL,
  `channel_id` int NOT NULL,
  PRIMARY KEY (`route_id`,`channel_id`),
  KEY `idx_notif_rc_channel` (`channel_id`),
  CONSTRAINT `fk_notif_rc_channel` FOREIGN KEY (`channel_id`) REFERENCES `notification_channels` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notif_rc_route` FOREIGN KEY (`route_id`) REFERENCES `notification_routes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `notification_routes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `feature` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `item_id` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_notif_route` (`workspace_id`,`feature`,`item_id`),
  CONSTRAINT `fk_notif_route_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `osint_lookups` (
  `id` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `workspace_id` int NOT NULL,
  `user_id` int NOT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `query_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_osint_lookup_workspace` (`workspace_id`,`created` DESC),
  KEY `fk_osint_lookup_user` (`user_id`),
  CONSTRAINT `fk_osint_lookup_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_osint_lookup_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `osint_provider_keys` (
  `workspace_id` int NOT NULL,
  `provider` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `key_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`workspace_id`,`provider`),
  CONSTRAINT `fk_osint_key_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `passwords` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `date` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_passwords_user` (`user_id`),
  KEY `idx_passwords_workspace` (`workspace_id`),
  CONSTRAINT `fk_password_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_password_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `pending_signups` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(320) COLLATE utf8mb4_general_ci NOT NULL,
  `username` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `watch_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `plan` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `opened_at` bigint DEFAULT NULL,
  `completed_at` bigint DEFAULT NULL,
  `expires_at` bigint NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `terms_accepted_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_pending_signup_email` (`email`),
  UNIQUE KEY `uniq_pending_signup_token` (`token_hash`),
  UNIQUE KEY `uniq_pending_signup_watch` (`watch_hash`),
  KEY `idx_pending_signup_username` (`username`),
  KEY `idx_pending_signup_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_audience_links` (
  `project_id` int NOT NULL,
  `site_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`project_id`,`site_id`),
  KEY `idx_project_audience_links_site` (`site_id`),
  KEY `fk_pal_workspace` (`workspace_id`),
  CONSTRAINT `fk_pal_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pal_site` FOREIGN KEY (`site_id`) REFERENCES `audience_sites` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pal_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_card_deps` (
  `card_id` int NOT NULL,
  `blocked_by_card_id` int NOT NULL,
  `project_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`card_id`,`blocked_by_card_id`),
  KEY `idx_card_deps_blocker` (`blocked_by_card_id`),
  KEY `fk_dep_project` (`project_id`),
  CONSTRAINT `fk_dep_blocker` FOREIGN KEY (`blocked_by_card_id`) REFERENCES `project_cards` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dep_card` FOREIGN KEY (`card_id`) REFERENCES `project_cards` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dep_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_card_reads` (
  `card_id` int NOT NULL,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `last_read_message_id` bigint NOT NULL DEFAULT '0',
  `read_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`card_id`,`user_id`),
  KEY `idx_card_reads_user` (`user_id`,`workspace_id`),
  KEY `fk_read_workspace` (`workspace_id`),
  CONSTRAINT `fk_read_card` FOREIGN KEY (`card_id`) REFERENCES `project_cards` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_read_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_read_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_cards` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `column_id` int DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `author_user_id` int DEFAULT NULL,
  `assignee_user_id` int DEFAULT NULL,
  `priority` tinyint NOT NULL DEFAULT '0',
  `start_date` bigint DEFAULT NULL,
  `due_date` bigint DEFAULT NULL,
  `estimate_minutes` int DEFAULT NULL,
  `required_open_count` int NOT NULL DEFAULT '0',
  `milestone_id` int DEFAULT NULL,
  `archived_at` bigint DEFAULT NULL,
  `message_count` int NOT NULL DEFAULT '0',
  `last_message_at` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_project_cards_column` (`column_id`,`archived_at`,`sort_order`),
  KEY `idx_project_cards_project` (`project_id`,`archived_at`),
  KEY `idx_project_cards_assignee` (`workspace_id`,`assignee_user_id`,`archived_at`),
  KEY `idx_project_cards_dates` (`project_id`,`due_date`),
  KEY `fk_card_milestone` (`milestone_id`),
  KEY `fk_card_author` (`author_user_id`),
  KEY `fk_card_assignee` (`assignee_user_id`),
  CONSTRAINT `fk_card_assignee` FOREIGN KEY (`assignee_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_card_author` FOREIGN KEY (`author_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_card_column` FOREIGN KEY (`column_id`) REFERENCES `project_columns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_card_milestone` FOREIGN KEY (`milestone_id`) REFERENCES `project_milestones` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_card_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_card_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_columns` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `counts_as_done` tinyint NOT NULL DEFAULT '0',
  `wip_limit` int DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_project_columns_project` (`project_id`,`sort_order`),
  KEY `fk_column_workspace` (`workspace_id`),
  CONSTRAINT `fk_column_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_column_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_database_links` (
  `project_id` int NOT NULL,
  `database_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`project_id`,`database_id`),
  KEY `idx_project_database_links_db` (`database_id`),
  KEY `fk_pdl_workspace` (`workspace_id`),
  CONSTRAINT `fk_pdl_database` FOREIGN KEY (`database_id`) REFERENCES `database_connections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pdl_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pdl_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_deploy_links` (
  `project_id` int NOT NULL,
  `target_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`project_id`,`target_id`),
  KEY `idx_project_deploy_links_target` (`target_id`),
  KEY `fk_pdpl_workspace` (`workspace_id`),
  CONSTRAINT `fk_pdpl_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pdpl_target` FOREIGN KEY (`target_id`) REFERENCES `deploy_targets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pdpl_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `project_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `actor_user_id` int DEFAULT NULL,
  `kind` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `ref_type` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ref_id` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_events_project` (`project_id`,`created`),
  KEY `fk_event_workspace` (`workspace_id`),
  KEY `fk_event_actor` (`actor_user_id`),
  CONSTRAINT `fk_event_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_event_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_event_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `card_id` int NOT NULL,
  `project_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `author_user_id` int DEFAULT NULL,
  `mentions` json DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `edited` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_messages_card` (`card_id`,`id`),
  KEY `fk_message_project` (`project_id`),
  KEY `fk_message_workspace` (`workspace_id`),
  KEY `fk_message_author` (`author_user_id`),
  CONSTRAINT `fk_message_author` FOREIGN KEY (`author_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_message_card` FOREIGN KEY (`card_id`) REFERENCES `project_cards` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_message_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_message_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_milestones` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `due_date` bigint NOT NULL,
  `reached_at` bigint DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_project_milestones_project` (`project_id`,`due_date`),
  KEY `fk_milestone_workspace` (`workspace_id`),
  CONSTRAINT `fk_milestone_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_milestone_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_repo_links` (
  `project_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `repo_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`project_id`,`repo_id`),
  KEY `idx_project_repo_links_repo` (`repo_id`),
  KEY `fk_prl_workspace` (`workspace_id`),
  CONSTRAINT `fk_prl_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_prl_repo` FOREIGN KEY (`repo_id`) REFERENCES `git_repos` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_prl_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `project_uptime_links` (
  `project_id` int NOT NULL,
  `service_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`project_id`,`service_id`),
  KEY `idx_project_uptime_links_service` (`service_id`),
  KEY `fk_pul_workspace` (`workspace_id`),
  CONSTRAINT `fk_pul_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pul_service` FOREIGN KEY (`service_id`) REFERENCES `uptime_services` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pul_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `projects` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `user_id` int DEFAULT NULL,
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  `security_tier` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'open',
  `version_source` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'manual',
  `show_overview` tinyint NOT NULL DEFAULT '0',
  `show_timeline` tinyint NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `start_date` bigint DEFAULT NULL,
  `due_date` bigint DEFAULT NULL,
  `archived_at` bigint DEFAULT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_projects_workspace` (`workspace_id`,`archived_at`,`sort_order`),
  KEY `fk_project_user` (`user_id`),
  CONSTRAINT `fk_project_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_project_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `quota_pauses` (
  `quota_key` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `item_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `owner_user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`quota_key`,`item_id`),
  KEY `idx_quota_pauses_owner` (`owner_user_id`),
  KEY `fk_quota_pauses_ws` (`workspace_id`),
  CONSTRAINT `fk_quota_pauses_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_quota_pauses_ws` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `quota_rechecks` (
  `owner_user_id` int NOT NULL,
  `due_at` bigint NOT NULL,
  PRIMARY KEY (`owner_user_id`),
  KEY `idx_quota_rechecks_due` (`due_at`),
  CONSTRAINT `fk_quota_rechecks_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `refresh_tokens` (
  `jti` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `user_id` int NOT NULL,
  `session_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `expires_at` bigint NOT NULL,
  `created_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  `revoked_at` bigint DEFAULT NULL,
  PRIMARY KEY (`jti`),
  KEY `idx_refresh_tokens_user` (`user_id`),
  KEY `idx_refresh_tokens_session` (`session_id`),
  CONSTRAINT `fk_refresh_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `remote_instances` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `label` varchar(60) COLLATE utf8mb4_general_ci NOT NULL,
  `origin` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_remote_instance_origin` (`user_id`,`origin`),
  KEY `idx_remote_instances_user` (`user_id`,`sort_order`),
  CONSTRAINT `fk_remote_instance_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sentinel_allowlist` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `device_id` char(36) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `rule` varchar(48) COLLATE utf8mb4_general_ci NOT NULL,
  `subject` varchar(512) COLLATE utf8mb4_general_ci NOT NULL,
  `subject_hash` binary(32) NOT NULL,
  `reason` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_by` int NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_allow` (`workspace_id`,`device_id`,`rule`,`subject_hash`),
  KEY `idx_allow_lookup` (`workspace_id`,`rule`),
  KEY `fk_allow_device` (`device_id`),
  KEY `fk_allow_user` (`created_by`),
  CONSTRAINT `fk_allow_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_allow_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_allow_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `site_maintenance` (
  `id` tinyint NOT NULL DEFAULT '1',
  `active` tinyint(1) NOT NULL DEFAULT '0',
  `message` varchar(1000) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `env_notice_dismissed` tinyint(1) NOT NULL DEFAULT '0',
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated_by` int DEFAULT NULL,
  `priority` tinyint(1) NOT NULL DEFAULT '0',
  `priority_updated` bigint DEFAULT NULL,
  `priority_by` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_site_maintenance_user` (`updated_by`),
  KEY `fk_site_maintenance_priority_user` (`priority_by`),
  CONSTRAINT `fk_site_maintenance_priority_user` FOREIGN KEY (`priority_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_site_maintenance_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_site_maintenance_single` CHECK ((`id` = 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_device_files` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `rel_path` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `rel_path_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'file',
  `hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `size` bigint NOT NULL,
  `mtime` bigint NOT NULL,
  `mode` smallint DEFAULT NULL,
  `synced_at` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sync_device_file` (`share_id`,`device_id`,`rel_path_hash`),
  KEY `idx_sync_device_files_device` (`device_id`),
  CONSTRAINT `fk_sdf_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sdf_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `device_id` char(36) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `rel_path` varchar(1024) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `message` varchar(500) COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_sync_events_share` (`share_id`,`created`),
  KEY `fk_sync_event_device` (`device_id`),
  CONSTRAINT `fk_sync_event_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sync_event_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_exclusions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `pattern` varchar(512) COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_sync_exclusions_share` (`share_id`),
  CONSTRAINT `fk_sync_exclusion_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_files` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `rel_path` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `rel_path_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'file',
  `hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `size` bigint NOT NULL,
  `mtime` bigint NOT NULL,
  `mode` smallint DEFAULT NULL,
  `source_device_id` char(36) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'present',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sync_file` (`share_id`,`rel_path_hash`),
  KEY `idx_sync_files_hash` (`share_id`,`hash`),
  KEY `fk_sync_file_device` (`source_device_id`),
  CONSTRAINT `fk_sync_file_device` FOREIGN KEY (`source_device_id`) REFERENCES `devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sync_file_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_meta` (
  `k` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `v` text COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_sessions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `state` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'scanning',
  `files_total` int NOT NULL DEFAULT '0',
  `bytes_total` bigint NOT NULL DEFAULT '0',
  `files_done` int NOT NULL DEFAULT '0',
  `bytes_done` bigint NOT NULL DEFAULT '0',
  `error` varchar(500) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `started` bigint NOT NULL DEFAULT (unix_timestamp()),
  `finished` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sync_sessions_share` (`share_id`,`started`),
  KEY `fk_sync_session_device` (`device_id`),
  CONSTRAINT `fk_sync_session_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sync_session_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_share_devices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `device_id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `local_path` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  `last_sync_at` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sync_share_device` (`share_id`,`device_id`),
  KEY `idx_sync_share_devices_device` (`device_id`),
  CONSTRAINT `fk_ssd_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ssd_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_shares` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `name` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
  `storage_key` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  `sort_order` int NOT NULL DEFAULT '0',
  `backup_prune_enabled` tinyint NOT NULL DEFAULT '0',
  `backup_limit_bytes` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  `conflict_policy` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'newest',
  `snapshot_enabled` tinyint NOT NULL DEFAULT '1',
  `snapshot_interval_hours` int NOT NULL DEFAULT '6',
  `snapshot_keep_days` int NOT NULL DEFAULT '90',
  `rate_up_bps` bigint DEFAULT NULL,
  `rate_down_bps` bigint DEFAULT NULL,
  `trash_keep_days` int NOT NULL DEFAULT '30',
  `integrity_scan_enabled` tinyint NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sync_shares_storage_key` (`storage_key`),
  KEY `idx_sync_shares_user` (`user_id`),
  KEY `fk_sync_share_workspace` (`workspace_id`),
  CONSTRAINT `fk_sync_share_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sync_share_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_snapshot_files` (
  `snapshot_id` bigint NOT NULL,
  `rel_path` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `rel_path_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'file',
  `hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `size` bigint NOT NULL,
  `mtime` bigint NOT NULL,
  `mode` smallint DEFAULT NULL,
  PRIMARY KEY (`snapshot_id`,`rel_path_hash`),
  KEY `idx_sync_snapshot_files_hash` (`hash`),
  CONSTRAINT `fk_sync_snapshot_file_snapshot` FOREIGN KEY (`snapshot_id`) REFERENCES `sync_snapshots` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_snapshots` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'auto',
  `label` varchar(120) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `file_count` int NOT NULL DEFAULT '0',
  `total_bytes` bigint NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_sync_snapshots_share` (`share_id`,`created`),
  CONSTRAINT `fk_sync_snapshot_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `sync_versions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `share_id` int NOT NULL,
  `rel_path` varchar(1024) COLLATE utf8mb4_general_ci NOT NULL,
  `hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `size` bigint NOT NULL,
  `mtime` bigint DEFAULT NULL,
  `source_device_id` char(36) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reason` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_sync_versions_share` (`share_id`,`created`),
  KEY `idx_sync_versions_hash` (`share_id`,`hash`),
  KEY `fk_sync_version_device` (`source_device_id`),
  CONSTRAINT `fk_sync_version_device` FOREIGN KEY (`source_device_id`) REFERENCES `devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sync_version_share` FOREIGN KEY (`share_id`) REFERENCES `sync_shares` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `uptime_checks` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `service_id` int NOT NULL,
  `checked_at` bigint NOT NULL,
  `up` tinyint NOT NULL,
  `http_status` int DEFAULT NULL,
  `response_ms` int DEFAULT NULL,
  `error` text COLLATE utf8mb4_general_ci,
  PRIMARY KEY (`id`),
  KEY `idx_uptime_checks_service` (`service_id`,`checked_at`),
  CONSTRAINT `fk_uptime_check_service` FOREIGN KEY (`service_id`) REFERENCES `uptime_services` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `uptime_daily` (
  `service_id` int NOT NULL,
  `day` bigint NOT NULL,
  `checks` int NOT NULL DEFAULT '0',
  `up_checks` int NOT NULL DEFAULT '0',
  `total_ms` bigint NOT NULL DEFAULT '0',
  `ms_samples` int NOT NULL DEFAULT '0',
  `min_ms` int DEFAULT NULL,
  `max_ms` int DEFAULT NULL,
  PRIMARY KEY (`service_id`,`day`),
  CONSTRAINT `fk_uptime_daily_service` FOREIGN KEY (`service_id`) REFERENCES `uptime_services` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `uptime_incidents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `service_id` int NOT NULL,
  `started_at` bigint NOT NULL,
  `ended_at` bigint DEFAULT NULL,
  `http_status` int DEFAULT NULL,
  `error` text COLLATE utf8mb4_general_ci,
  `notified` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_uptime_incidents_service` (`service_id`,`started_at`),
  CONSTRAINT `fk_uptime_incident_service` FOREIGN KEY (`service_id`) REFERENCES `uptime_services` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `uptime_services` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `content` text COLLATE utf8mb4_general_ci NOT NULL,
  `kind` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'http',
  `method` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'GET',
  `expected_status` int DEFAULT NULL,
  `interval_seconds` int NOT NULL DEFAULT '60',
  `timeout_seconds` int NOT NULL DEFAULT '10',
  `failure_threshold` int NOT NULL DEFAULT '2',
  `retention_days` int DEFAULT NULL,
  `enabled` tinyint NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `status` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'unknown',
  `consecutive_failures` int NOT NULL DEFAULT '0',
  `last_checked_at` bigint DEFAULT NULL,
  `last_response_ms` int DEFAULT NULL,
  `last_http_status` int DEFAULT NULL,
  `last_error` text COLLATE utf8mb4_general_ci,
  `baseline_enc` text COLLATE utf8mb4_general_ci,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_uptime_services_user` (`user_id`),
  KEY `idx_uptime_services_due` (`enabled`,`last_checked_at`),
  KEY `fk_uptime_service_workspace` (`workspace_id`),
  CONSTRAINT `fk_uptime_service_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_uptime_service_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `user_2fa` (
  `user_id` int NOT NULL,
  `secret_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `enabled` tinyint NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `confirmed_at` bigint DEFAULT NULL,
  `last_used_counter` bigint DEFAULT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_2fa_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `user_2fa_backup_codes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `code_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `used_at` bigint DEFAULT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_2fa_backup_user` (`user_id`),
  CONSTRAINT `fk_2fa_backup_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `user_secret_keys` (
  `user_id` int NOT NULL,
  `dek_wrapped` text COLLATE utf8mb4_general_ci NOT NULL,
  `open_dek_wrapped` text COLLATE utf8mb4_general_ci,
  `wrap_mode` enum('server','password') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'server',
  `kdf_salt` varbinary(32) DEFAULT NULL,
  `recovery_wrapped` text COLLATE utf8mb4_general_ci,
  `recovery_salt` varbinary(32) DEFAULT NULL,
  `recovery_version` int NOT NULL DEFAULT '1',
  `version` int NOT NULL DEFAULT '1',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_secret_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(320) COLLATE utf8mb4_general_ci NOT NULL,
  `username` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `password_hash` text COLLATE utf8mb4_general_ci NOT NULL,
  `avatar` mediumtext COLLATE utf8mb4_general_ci NOT NULL DEFAULT (_utf8mb4'default-user.png'),
  `color` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  `role` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'user',
  `status` enum('active','suspended') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  `personal_workspace_id` int NOT NULL,
  `default_workspace_id` int DEFAULT NULL,
  `settings` json NOT NULL,
  `re_auth_interval` int DEFAULT NULL,
  `last_login` bigint NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `terms_accepted_at` bigint DEFAULT NULL,
  `e2e_run` varchar(48) COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `uniq_personal_workspace` (`personal_workspace_id`),
  KEY `fk_user_default_workspace` (`default_workspace_id`),
  KEY `idx_users_e2e_run` (`e2e_run`),
  CONSTRAINT `fk_user_default_workspace` FOREIGN KEY (`default_workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `weather_locations` (
  `id` char(36) COLLATE utf8mb4_general_ci NOT NULL,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `label` varchar(120) COLLATE utf8mb4_general_ci NOT NULL,
  `latitude` double NOT NULL,
  `longitude` double NOT NULL,
  `format` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'current',
  `days` int NOT NULL DEFAULT '7',
  `provider` varchar(32) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'open-meteo',
  `position` int NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_weather_user` (`user_id`),
  KEY `idx_weather_workspace` (`workspace_id`),
  CONSTRAINT `fk_weather_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_weather_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `weather_provider_keys` (
  `workspace_id` int NOT NULL,
  `provider` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `key_enc` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`workspace_id`,`provider`),
  CONSTRAINT `fk_weatherkey_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `workspace_members` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `role_id` int DEFAULT NULL,
  `date` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_member` (`user_id`,`workspace_id`),
  UNIQUE KEY `uniq_workspace_member` (`workspace_id`,`user_id`),
  KEY `idx_workspace_members_user` (`user_id`),
  KEY `idx_workspace_members_workspace` (`workspace_id`),
  KEY `fk_member_role` (`role_id`),
  CONSTRAINT `fk_member_role` FOREIGN KEY (`role_id`) REFERENCES `workspace_roles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_member_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_member_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `workspace_roles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspace_id` int NOT NULL,
  `name` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `color` char(7) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '#22d3ee',
  `position` int NOT NULL DEFAULT '0',
  `capabilities` json NOT NULL,
  `features` json NOT NULL,
  `is_default` tinyint NOT NULL DEFAULT '0',
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`id`),
  KEY `idx_workspace_roles_ws` (`workspace_id`,`position`),
  CONSTRAINT `fk_role_workspace` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `workspace_secret_keys` (
  `workspace_id` int NOT NULL,
  `dek_wrapped` text COLLATE utf8mb4_general_ci NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `updated` bigint NOT NULL DEFAULT (unix_timestamp()),
  PRIMARY KEY (`workspace_id`),
  CONSTRAINT `fk_workspace_dek` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `workspaces` (
  `id` int NOT NULL AUTO_INCREMENT,
  `kind` enum('personal','shared') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'shared',
  `name` varchar(128) COLLATE utf8mb4_general_ci NOT NULL,
  `logo` varchar(256) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'default-workspace.png',
  `owner_user_id` int NOT NULL,
  `features` json NOT NULL,
  `created` bigint NOT NULL DEFAULT (unix_timestamp()),
  `theme` mediumtext COLLATE utf8mb4_general_ci,
  `home_layout` mediumtext COLLATE utf8mb4_general_ci,
  PRIMARY KEY (`id`),
  KEY `idx_workspaces_owner` (`owner_user_id`,`kind`),
  CONSTRAINT `fk_workspace_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
