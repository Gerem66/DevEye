-- Deux index que les lectures réclamaient sans les avoir.
--
-- ⚠️ Ce sont des ALTER sur les deux tables qui grandissent le plus vite. Sur
-- une base chargée, ils prennent du temps et du disque : à jouer en sachant
-- que le démarrage attendra.

-- `retention()` groupe les événements d'une fenêtre par session, et
-- `idx_audience_events_window` ne porte pas `session_id` : chaque ligne de la
-- fenêtre demandait un accès à la table, puis un temporaire de groupement. La
-- vue Entonnoirs rejoue cette requête par entonnoir, jusqu'à vingt, et le
-- sommaire d'un site la déclenche à chaque ouverture.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_events'
            AND INDEX_NAME = 'idx_audience_events_funnel');
SET @s = IF(@c = 0,
    'ALTER TABLE audience_events ADD INDEX idx_audience_events_funnel (site_id, ts, session_id)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La liste des sites compte les visiteurs distincts des dernières 24 h, deux
-- fois par site (les deux branches de l'UNION des projections).
-- `idx_audience_sessions_last` servait la fenêtre mais pas `visitor_ref`, donc
-- un accès à la table par session.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audience_sessions'
            AND INDEX_NAME = 'idx_audience_sessions_visitors');
SET @s = IF(@c = 0,
    'ALTER TABLE audience_sessions ADD INDEX idx_audience_sessions_visitors (site_id, last_at, visitor_ref)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
