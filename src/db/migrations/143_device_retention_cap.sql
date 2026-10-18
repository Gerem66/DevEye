-- Plus d'un an d'historique d'appareil est reserve aux administrateurs de
-- l'instance. Les appareils des autres comptes reviennent a un an, ceux d'un
-- espace qu'un administrateur possede gardent leur reglage.
UPDATE devices d
JOIN workspaces w ON w.id = d.workspace_id
JOIN users u ON u.id = w.owner_user_id
SET d.retention_days = 365
WHERE d.retention_days > 365 AND u.role <> 'admin';
