-- Sentinelle laissait les fils du noyau entrer dans sa ligne de base. Leur nom
-- encode un CPU et un index que le noyau recycle en continu
-- (`kworker/6:0H-kblockd`, `jbd2/nvme1n1p1-8`), si bien que chacun finissait par
-- franchir les seuils de `process.vanished` puis par s'evaporer, sans jamais se
-- resoudre : des centaines de constats ouverts pour un phenomene qui n'est pas
-- un evenement. L'agent remonte desormais `PF_KTHREAD` et le moteur les ecarte.
--
-- Reste a effacer ce que l'ancien comportement a produit. Le critere tient a la
-- forme de la cle : `nom|chemin` pour un programme du disque, `nom` seul sinon.
-- Un fil du noyau n'ayant pas d'executable, son sujet ne porte jamais de barre
-- verticale, et le `/` de son index ne peut alors venir que de la.
--
-- Rejouable : apres un passage il ne reste rien a effacer.

-- Les constats de derive portant sur un fil du noyau. Les regles `exec.*` n'y
-- sont pas : un chemin sur un nom de fil du noyau est une usurpation, et c'est
-- precisement ce qu'on veut garder.
DELETE FROM device_findings
 WHERE rule IN ('process.vanished', 'process.new', 'process.new_listener',
                'process.user_changed', 'process.resource_anomaly')
   AND subject NOT LIKE '%|%'
   AND (subject LIKE '%/%' OR subject LIKE '[%]');

-- Les acquittements poses sur ces memes sujets : la situation ne pouvant plus
-- se reproduire, la decision n'a plus rien a couvrir.
DELETE FROM sentinel_allowlist
 WHERE rule IN ('process.vanished', 'process.new', 'process.new_listener',
                'process.user_changed', 'process.resource_anomaly')
   AND subject NOT LIKE '%|%'
   AND (subject LIKE '%/%' OR subject LIKE '[%]');

-- Les lignes de base elles-memes. Sans cela la passe lente les relirait et
-- rouvrirait les memes constats des la prochaine heure.
DELETE FROM device_baseline
 WHERE kind = 'process'
   AND item_key NOT LIKE '%|%'
   AND (item_key LIKE '%/%' OR item_key LIKE '[%]');
