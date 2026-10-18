-- Plus de deux ans d'historique detaille, ou tout garder, est reserve aux
-- administrateurs de l'instance. Les services des autres comptes reviennent a
-- deux ans, ceux d'un espace qu'un administrateur possede gardent leur reglage.
UPDATE uptime_services s
JOIN workspaces w ON w.id = s.workspace_id
JOIN users u ON u.id = w.owner_user_id
SET s.retention_days = 730
WHERE (s.retention_days IS NULL OR s.retention_days > 730) AND u.role <> 'admin';
