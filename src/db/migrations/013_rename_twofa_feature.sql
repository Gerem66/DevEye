-- Rename the security page's feature id from 'twofa' to 'security'.
-- The page now bundles three protections (2FA, password encryption, password
-- re-validation window), so the broader 'security' id reflects its scope. The
-- genuine 2FA commands (twofa.*) and their backing tables are unaffected.
--
-- `features` is a JSON array of feature-id strings on both users (personal
-- workspace) and workspaces. Feature ids are unique within each array, so a
-- single JSON_SEARCH/JSON_REPLACE per row safely swaps the one occurrence.

UPDATE users
SET features = JSON_REPLACE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'twofa')), 'security')
WHERE JSON_SEARCH(features, 'one', 'twofa') IS NOT NULL;

UPDATE workspaces
SET features = JSON_REPLACE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'twofa')), 'security')
WHERE JSON_SEARCH(features, 'one', 'twofa') IS NOT NULL;
