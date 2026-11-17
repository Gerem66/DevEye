-- Le catalogue des fins de vie garde maintenant les dates de chaque branche
-- (sortie, support actif, support etendu) et la fiche de chaque logiciel. Les
-- lignes en base n'en ont rien : oublier la date du dernier chargement fait
-- relire le dump au premier passage de la veille.
--
-- Rejouable : sans ligne, rien a effacer.

DELETE FROM ft_cve_state WHERE k = 'eolFetchedAt';
