-- Suppression des invitations d'espace par lien : on rejoint un espace parce
-- qu'un membre vous y ajoute par votre adresse (tout compte existe deja, sur
-- invitation d'un administrateur). Les adhesions existantes ne bougent pas.
-- `uniq_workspace_member` (054) reste : il ne doit rien aux invitations.

DROP TABLE IF EXISTS workspace_invites;
