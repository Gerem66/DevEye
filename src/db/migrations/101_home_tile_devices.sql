-- La tuile Monitoring de l'accueil porte l'id de sa feature : `devices`.
-- `nativeHomeFeatureIdSchema` dit `devices` la ou il disait `monitoring`, et
-- les dispositions persistees (`workspaces.home_layout`, JSON ecrit par
-- `JSON.stringify` sans espaces) portent encore l'ancien id : sans reprise, la
-- tuile ne parse plus et l'accueil se relit vide.
--
-- L'id d'une feature n'apparait dans ce JSON que comme ELEMENT DE TABLEAU
-- (`sections[].items`, `items` d'un dossier) : `["monitoring"` en tete,
-- `,"monitoring"` ensuite. Une valeur d'objet est precedee de `:` et n'est
-- jamais touchee, un guillemet interne est echappe par JSON.stringify, et
-- aucune cle d'objet ne s'appelle `monitoring`.
--
-- Rejouable : apres un passage, plus aucune ligne ne porte ces sequences.
UPDATE workspaces
   SET home_layout = REPLACE(REPLACE(home_layout, '["monitoring"', '["devices"'), ',"monitoring"', ',"devices"')
 WHERE home_layout LIKE '%["monitoring"%'
    OR home_layout LIKE '%,"monitoring"%';
