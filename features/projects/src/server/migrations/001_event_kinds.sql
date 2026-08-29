-- Les genres d'événements de la frise prennent le préfixe du module, de
-- `project.*` à `projects.*`. Sans ce renommage, le contrat replie les lignes déjà
-- écrites sur son genre de repli et la frise annonce un « statut modifié » là où un
-- projet a été créé, renommé ou archivé.
--
-- Rejouable : `project.%` ne recouvre pas `projects.%`, une ligne déjà renommée
-- n'est plus visée. Les genres des cartes, des jalons et des déploiements ne
-- bougent pas.

UPDATE project_events
   SET kind = CONCAT('projects.', SUBSTRING(kind, 9))
 WHERE kind LIKE 'project.%';
