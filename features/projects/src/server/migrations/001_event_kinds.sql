-- Les genres d'événements de la frise prennent le préfixe du module.
--
-- Au rapatriement de Projets en module, ses commandes et ses clés sont passées
-- de `project.*` à `projects.*` (un module parle sous son id), et le genre des
-- événements de frise (`projectEventKindSchema`) avec elles. Les lignes déjà
-- écrites portaient l'ancien préfixe : sans ce renommage, le contrat les
-- replierait toutes sur son genre de repli et la frise afficherait un
-- « statut modifié » là où un projet a été créé, renommé ou archivé.
--
-- Rejouable : `project.%` ne recouvre pas `projects.%` (la lettre suivant
-- « project » diffère), une ligne déjà renommée n'est plus visée. Les genres
-- des cartes, des jalons et des déploiements (`card.*`, `milestone.*`,
-- `deploy.*`) ne bougent pas.

UPDATE project_events
   SET kind = CONCAT('projects.', SUBSTRING(kind, 9))
 WHERE kind LIKE 'project.%';
