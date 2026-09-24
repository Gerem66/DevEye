-- `preview` reserve une feature aux administrateurs : sa tuile disparait pour
-- les autres comptes, ses commandes et routes publiques leur sont refusees, et
-- son service de fond continue.
--   UPDATE feature_maintenance SET level = 'preview' WHERE feature = 'mailserver'

ALTER TABLE feature_maintenance
    MODIFY level ENUM('requests', 'full', 'preview') NOT NULL DEFAULT 'requests';
