-- La tuile Monitoring de l'accueil porte l'id de sa feature : `devices`.
--
-- Depuis le rapatriement d'Appareils en module (features/devices), une tuile
-- de fonctionnalite porte l'id de la feature dont le module fournit la carte
-- et la vue, comme pour tous les modules : `nativeHomeFeatureIdSchema`
-- (DevEye-Types, domain/home.ts) dit `devices` la ou il disait `monitoring`.
-- Les dispositions persistees (`workspaces.home_layout`, le JSON de
-- `homeLayoutSchema` ecrit par `JSON.stringify` sans espaces depuis
-- `home.setLayout`) portent encore l'ancien id. Sans reprise, la tuile ne
-- parse plus et l'accueil se relit vide.
--
-- Ou l'id d'une feature apparait dans ce JSON, et sous quelle forme exacte :
--   - une tuile de fonctionnalite est un element de `sections[].items`, une
--     chaine nue entre des tuiles objet (raccourcis, dossiers) et des UUID
--     d'appareils,
--   - un element de dossier est un element du `items` du dossier,
--   - la barre du haut (`topbar`) portait deja l'id `devices` pour son widget,
--     jamais `monitoring`.
-- Dans les deux cas la chaine est un ELEMENT DE TABLEAU : `["monitoring"` en
-- tete de tableau, `,"monitoring"` ensuite. Une valeur d'objet (le `title`, la
-- `description` ou l'`icon` d'un raccourci, l'`id` d'une section, d'un dossier
-- ou d'un raccourci) est precedee de `:` et n'est jamais touchee. Un guillemet
-- a l'interieur d'une chaine est echappe par JSON.stringify et ne forme pas ces
-- sequences. Aucune cle d'objet ne s'appelle `monitoring`.
--
-- `users.home_layout` (ajoutee par la 028, videe par la 041) a ete copiee
-- vers `workspaces` par la 046 et supprimee par la 047 : il n'y a plus qu'une
-- colonne a reprendre.
--
-- Rejouable : apres un passage, plus aucune ligne ne porte ces sequences.
UPDATE workspaces
   SET home_layout = REPLACE(REPLACE(home_layout, '["monitoring"', '["devices"'), ',"monitoring"', ',"devices"')
 WHERE home_layout LIKE '%["monitoring"%'
    OR home_layout LIKE '%,"monitoring"%';
