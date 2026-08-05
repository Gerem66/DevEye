-- Suppression des invitations d'espace par lien.
--
-- On rejoint desormais un espace parce qu'un membre vous y met, en designant
-- votre adresse : l'inscription etant deja sur invitation d'un administrateur,
-- tout compte candidat existe et une adresse suffit. Le jeton n'ajoutait qu'un
-- secret transmissible, a expirer et a revoquer, pour le meme resultat.
--
-- Les adhesions deja creees par un lien ne bougent pas : elles vivent dans
-- `workspace_members`, ici on ne retire que le mecanisme d'entree. Les liens
-- encore actifs, eux, cessent de fonctionner -- c'est l'objet du changement.
--
-- `uniq_workspace_member`, pose par 054 sur `workspace_members`, reste : il ne
-- doit rien aux invitations et garde un compte de figurer deux fois dans le
-- meme espace.
--
-- Rejouable : `IF EXISTS` couvre aussi bien une base ou 054 n'a jamais tourne
-- qu'un second passage de cette migration.

DROP TABLE IF EXISTS workspace_invites;
