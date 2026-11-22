-- La fonctionnalité OSINT n'est plus servie : ses tables et chaque ligne qui
-- la nomme disparaissent. Les dispositions d'accueil sont réécrites ici, pas
-- laissées en l'état : une tuile dont l'id n'existe plus fait échouer la
-- lecture de toute la disposition, et l'accueil de l'espace retomberait sur
-- celui par défaut.
DROP TABLE IF EXISTS ft_osint_usage;
DROP TABLE IF EXISTS osint_provider_keys;
DROP TABLE IF EXISTS osint_lookups;
DELETE FROM _migrations WHERE name LIKE 'osint/%';

DELETE FROM feature_kv WHERE feature = 'osint';
DELETE FROM feature_domains WHERE feature = 'osint';
DELETE FROM feature_maintenance WHERE feature = 'osint';
DELETE FROM notification_routes WHERE feature = 'osint';
DELETE FROM notification_channels WHERE feature = 'osint';
DELETE FROM item_shares WHERE feature = 'osint';
DELETE FROM item_role_grants WHERE feature = 'osint';
DELETE FROM user_hidden_notices WHERE feature = 'osint';
DELETE FROM logs WHERE action LIKE 'osint.%';
DELETE FROM quota_pauses WHERE quota_key LIKE 'osint.%';

UPDATE workspaces
SET features = JSON_REMOVE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'osint')))
WHERE JSON_SEARCH(features, 'one', 'osint') IS NOT NULL;

UPDATE workspace_roles r
SET r.features = COALESCE(
    (SELECT JSON_ARRAYAGG(g.grant_json)
     FROM JSON_TABLE(r.features, '$[*]' COLUMNS (
         grant_json JSON PATH '$',
         feature VARCHAR(64) PATH '$.feature'
     )) AS g
     WHERE g.feature IS NULL OR g.feature <> 'osint'),
    JSON_ARRAY())
WHERE JSON_CONTAINS(r.features, JSON_OBJECT('feature', 'osint'));

-- La disposition est le texte de JSON.stringify, sans espaces. Chaque motif
-- encadre l'id par un crochet ou une virgule des deux côtés : il ne prend
-- qu'un élément de tableau (barre, section, dossier), jamais une valeur
-- d'objet, que précède un deux-points.
UPDATE workspaces
SET home_layout = REPLACE(REPLACE(REPLACE(REPLACE(home_layout,
    '["osint"]', '[]'),
    '["osint",', '['),
    ',"osint",', ','),
    ',"osint"]', ']')
WHERE home_layout LIKE '%"osint"%';
