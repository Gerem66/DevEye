-- Remove structural pages from the persisted `features` lists.
--
-- `features` (on users for the personal workspace, and on workspaces) is meant
-- to hold only modular, per-workspace features that can be added/removed. The
-- structural pages 'profile' and 'security' (formerly 'twofa') are part of
-- DevEye itself, reached from the navbar, and must never live in this list.
--
-- This drops 'twofa', 'security' and 'profile' entries from existing rows.
-- Genuine 2FA (twofa.* commands and their tables) is unaffected. Each value
-- appears at most once per array, but JSON paths shift after a removal, so each
-- value is removed in its own statement (re-evaluating the path each time).

-- users.features
UPDATE users SET features = JSON_REMOVE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'twofa')))
    WHERE JSON_SEARCH(features, 'one', 'twofa') IS NOT NULL;
UPDATE users SET features = JSON_REMOVE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'security')))
    WHERE JSON_SEARCH(features, 'one', 'security') IS NOT NULL;
UPDATE users SET features = JSON_REMOVE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'profile')))
    WHERE JSON_SEARCH(features, 'one', 'profile') IS NOT NULL;

-- workspaces.features
UPDATE workspaces SET features = JSON_REMOVE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'twofa')))
    WHERE JSON_SEARCH(features, 'one', 'twofa') IS NOT NULL;
UPDATE workspaces SET features = JSON_REMOVE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'security')))
    WHERE JSON_SEARCH(features, 'one', 'security') IS NOT NULL;
UPDATE workspaces SET features = JSON_REMOVE(features, JSON_UNQUOTE(JSON_SEARCH(features, 'one', 'profile')))
    WHERE JSON_SEARCH(features, 'one', 'profile') IS NOT NULL;
