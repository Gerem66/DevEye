-- Les references d'une CVE portaient le champ `source` du NVD, qui est
-- l'identifiant du CNA (une adresse de courriel, parfois un UUID nu) et jamais
-- le nom d'un site. Il cede la place aux `tags`, qui disent ce que la page
-- contient : correctif, exploit, avis de l'editeur.
--
-- Les lignes deja rangees gardent leurs URL et repartent avec des etiquettes
-- vides, que le NVD redonnera au prochain passage de l'ingestion sur cette CVE.
-- Sans cette reecriture l'ancienne forme echoue a la validation de sortie, et
-- une seule ligne perimee emporte toute la reponse qui la contient.
--
-- Rejouable : apres coup, plus aucune ligne ne porte `$[0].source`.

UPDATE ft_cve_entries
SET refs = COALESCE(
        (SELECT JSON_ARRAYAGG(JSON_OBJECT('url', jt.url, 'tags', JSON_ARRAY()))
         FROM JSON_TABLE(refs, '$[*]' COLUMNS (url VARCHAR(2048) PATH '$.url')) AS jt
         WHERE jt.url IS NOT NULL),
        JSON_ARRAY())
WHERE JSON_CONTAINS_PATH(refs, 'one', '$[0].source');

-- Les lignes reecrites n'ont pas leurs etiquettes, et l'ingestion avance par
-- date de MODIFICATION : une CVE que le NVD ne retouche pas ne repasserait
-- jamais. Le curseur repart donc d'une semaine en arriere, ce que le service
-- rattrape en un tour, pour que le fil affiche des etiquettes tout de suite.
-- Les CVE plus anciennes gardent leurs URL et attendent d'etre retouchees.
DELETE FROM ft_cve_state WHERE k = 'ingestCursor';
