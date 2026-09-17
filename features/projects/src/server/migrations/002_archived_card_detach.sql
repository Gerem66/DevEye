-- Une carte archivée ne circule plus, et l'archive ne montre aucune colonne : la
-- sienne ne veut plus rien dire. La contrainte étant en CASCADE, elle retenait
-- pourtant sa colonne, qu'on ne pouvait plus retirer sans détruire ces cartes.
--
-- `column_id` devient donc nullable et la contrainte passe en SET NULL : retirer
-- une colonne détache ses cartes archivées au lieu de les emporter, et restaurer
-- une carte détachée lui redonne la première colonne du tableau.
--
-- La contrainte est reposée à l'identique juste après, son nom compris : aucun
-- ALTER de MySQL ne change le ON DELETE d'une contrainte en place, la retirer
-- pour la recréer est le seul chemin.

ALTER TABLE project_cards DROP FOREIGN KEY fk_card_column;

ALTER TABLE project_cards MODIFY column_id INT NULL;

ALTER TABLE project_cards
    ADD CONSTRAINT fk_card_column FOREIGN KEY (column_id) REFERENCES project_columns(id) ON DELETE SET NULL;
