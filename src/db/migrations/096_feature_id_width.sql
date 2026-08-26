-- L'identifiant d'une feature dans les tables du socle qui en portent un.
--
-- VARCHAR(24) datait des ids natifs (16 caractères au plus). Un module externe
-- s'appelle `x-<slug>` avec un slug de 25 au plus, soit 27 : un canal, une
-- route, un partage ou une restriction d'un module à id long échouaient à
-- l'insertion. Le même 32 que `feature_kv` (095), partout.

ALTER TABLE notification_channels MODIFY COLUMN feature VARCHAR(32) NOT NULL;
ALTER TABLE notification_routes   MODIFY COLUMN feature VARCHAR(32) NOT NULL;
ALTER TABLE item_shares           MODIFY COLUMN feature VARCHAR(32) NOT NULL;
ALTER TABLE item_role_grants      MODIFY COLUMN feature VARCHAR(32) NOT NULL;
