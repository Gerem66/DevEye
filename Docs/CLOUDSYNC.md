# CloudSync — synchronisation de dossier type « Synology Drive »

Un *partage* est un dossier « cloud » géré par le serveur, synchronisé entre
plusieurs appareils via l'agent Rust. Le serveur orchestre tout ; l'agent ne
décide jamais rien.

**Invariant absolu : rien n'est jamais détruit sans qu'une version de
sauvegarde vérifiée par hash existe déjà côté serveur.** Toute voie
destructrice (écrasement, suppression propagée, conflit, restauration) passe
par le verrou unique `src/cloudSync/versions.ts::archiveCurrent` /
`archiveBlobAsVersion`, qui refuse si le blob n'est pas physiquement présent.

Corollaire : **aucune impasse non plus.** Si la preuve d'archivage a disparu
(purge trop gourmande, version effacée à la main), la suppression propagée
n'est pas refusée en boucle — le contenu de l'appareil remonte et ressuscite la
ligne d'index. Une session converge toujours, dans un sens ou dans l'autre.

## Stockage serveur

- **Blob store par partage** (`src/cloudSync/blobStore.ts`), enraciné dans le
  `storage_path` choisi à la création :
  `blobs/<h0h1>/<h2h3>/<sha256-du-clair>` + `tmp/<hash>.part` (transferts en
  cours, **nommés par hash pour être reprenables** — voir plus bas).
- Chiffré au repos (AES-256-GCM en flux, clé serveur wrappée) — voir
  `Docs/SECURITY_MODEL.md § CloudSync` et `src/cloudSync/blobCrypto.ts`.
- L'arborescence n'existe que dans MySQL (`sync_files`) ; le disque ne
  contient que des blobs opaques dédupliqués (index vivant ∪ versions
  partagent les blobs par hash ; GC uniquement via `gcBlobIfUnreferenced`,
  sous le mutex du partage).

### Où le mettre, et pourquoi ça compte

Le `storage_path` est un chemin **du serveur**. Ce n'est PAS un miroir lisible du
dossier : on n'y trouve que `blobs/` (contenus chiffrés, nommés par hash) et
`tmp/`. Chercher ses fichiers par leur nom à cet endroit ne donnera jamais rien —
l'arborescence n'existe que dans MySQL.

**Il n'est plus saisi.** Le demander revenait à faire deviner l'arborescence
interne d'un conteneur, et menait à créer le partage sur sa couche d'écriture :
invisible depuis l'hôte, effacé au redéploiement. `storagePathForName` le dérive
du nom (`« Documents »` → `<racine>/documents`, suffixé si déjà pris — deux
partages ne doivent jamais partager un blob store, leurs GC se détruiraient
mutuellement).

**Deux variables, deux chemins**, et les confondre revient à écrire dans le
conteneur (donc à tout perdre au redéploiement) :

| Variable | Côté | Rôle |
|---|---|---|
| `CLOUDSYNC_STORAGE_ROOT` | hôte | source du montage, lue par docker compose SEUL |
| `CLOUDSYNC_STORAGE_DIR` | conteneur | où le serveur crée les partages (défaut `/data/cloudsync`) |

`validateStoragePath` refuse tout chemin qui ne serait sous aucun montage —
`mountPointFor` (exportée et testée) rattache un partage au volume qui le porte,
un sous-dossier n'étant jamais lui-même un point de montage. Hors conteneur,
rien n'est refusé et les deux variables se confondent.

## Tables (migration `031_cloud_sync.sql`)

| Table | Rôle |
|---|---|
| `sync_meta` | BMK wrappée (`blob_key_wrapped`) |
| `sync_shares` | partages (chemin de stockage, statut, purge auto) |
| `sync_share_devices` | appareils attachés (dossier local, statut, dernier sync) |
| `sync_exclusions` | exclusions (`path` exact, `name` de composant, `regex`) |
| `sync_files` | **index canonique** (une ligne par chemin, y compris `deleted`) |
| `sync_device_files` | **baseline par appareil** — la 3ᵉ voie du merge |
| `sync_versions` | corbeille/versions (raison : overwrite/delete/conflict/restore/excluded) |
| `sync_sessions` | progression persistée + sessions orphelines soldées |
| `sync_events` | journal par partage (erreurs datées, fichier + appareil) — popup « Logs », rétention 90 j |
| `sync_snapshots` / `sync_snapshot_files` | **points de restauration** du partage entier (migration `081`) |

L'unicité des chemins passe par `rel_path_hash` (SHA-256 du chemin relatif
NFC-normalisé) : un `VARCHAR(1024)` ne tient pas dans un index unique utf8mb4.

Une ligne d'index porte aussi `kind` (`file` | `dir`) et `mode` (bits Unix) —
voir « Dossiers vides » et « Permissions » plus bas.

## Algorithme (merge 3 voies, orchestré serveur)

Session par (partage × appareil), sérialisée par partage (mutex dans
`engine.ts` — sessions, purge, restauration et GC ne se croisent jamais) :

1. **Scan** : l'agent parcourt le dossier local (exclusions appliquées,
   symlinks ignorés, hashing incrémental via cache size+mtime) et streame des
   lots `sync.index` (≤ 500 entrées).
2. **Plan** : `planner.ts` (pur, sans I/O) croise *appareil* / *baseline* /
   *index serveur*. Règle d'or : **une suppression n'est jamais inférée sans
   ligne de baseline** — premier sync ou ré-attachement = merge pur, zéro
   suppression possible. Conflits (gagnant = last-writer-wins sur le mtime,
   tolérance 5 s, égalité = serveur) selon la politique du partage :
   `newest` = le perdant est archivé en version ; `rename` = le perdant reste
   VIVANT sous `<nom> (conflit AAAA-MM-JJ HH-MM-SS).<ext>` et se propage
   partout comme un fichier normal.
3. **Transferts** (séquentiels, atomiques, ordres stricts) :
   - upload : blob vérifié par hash → archive de l'ancien → index → baseline ;
   - download : chunks acquittés (fenêtre 4) → install atomique agent
     (tmp + vérif hash/taille + mtime + rename) → `opResult ok` → baseline ;
   - suppression serveur : archive → `state='deleted'` → baseline ;
   - suppression appareil : le serveur vérifie qu'une version de CE contenu
     existe, puis l'agent déplace vers `.deveye-trash/<horodatage>/…`
     (jamais de unlink ; purge locale > 30 j).
4. La progression (totaux connus dès le plan → vraie barre) est poussée aux
   abonnés web (`cloudSync.progress`/`cloudSync.state`, abonnement par
   partage) et persistée ~2 s.

Déclencheurs : connexion d'agent, watcher local débouncé (`notify`, 2 s de
calme / 30 s max — il ne porte aucune vérité, il déclenche un scan),
changement de config, **propagation croisée** (une session qui a modifié
l'index canonique re-planifie immédiatement les autres appareils du partage —
c'est ce qui rend la synchro « en direct » de A vers B), et un **filet
horaire** (`scheduleAllActive` dans le prune : un événement de watcher raté ne
laisse jamais deux appareils divergents plus d'une heure). Une session
interrompue n'importe où se relance depuis le scan et converge (idempotence).

**Exclusions** : un chemin exclu devient invisible au merge (ni envoyé, ni
téléchargé, ni supprimé) ET est retiré du cloud à l'ajout de la règle —
archivé en version (`excluded`, restaurable), marqué supprimé, baselines
purgées. Les copies locales des appareils restent intactes.

**Journal** : chaque échec par fichier (chemin refusé, collision de casse,
fichier illisible, install refusée…) et chaque session en erreur est consigné
dans `sync_events` — visible dans la popup « Logs » de la feature (message,
date, fichier, appareil). L'insertion déduplique sur 24 h : un fichier
durablement en échec est re-vu à chaque cycle et noierait sinon la popup.

## Règles de nommage (les trois OS, en tout temps)

Un nom légal sous Unix mais impossible sous Windows (`aux.txt`, `a:b`, `fin.`,
`CON`, `?`, `*`, `|`, `<`, `>`, `"`) est **refusé partout**, quel que soit l'OS
qui l'a créé. Sans ça, l'agent Windows échouerait sur ce fichier à chaque cycle,
indéfiniment, et son dossier divergerait pour toujours. La règle vit en double,
et les deux copies **doivent rester d'accord** :
`src/cloudSync/pathValidation.ts::relPathProblem` et
`agent/src/sync/paths.rs::rel_path_problem` (mêmes jeux de tests des deux côtés).

Le fichier reste intact sur la machine qui l'a créé : il sort simplement du
cloud par la voie des exclusions (archivé en version, baselines purgées, filtré
symétriquement dans `plan()`), et la raison exacte part dans le journal.

Deux fichiers qui ne diffèrent que par la casse, ou seulement par leur
normalisation Unicode (NFC/NFD — courant en venant d'un Mac), sont écartés tous
les deux et signalés : en garder un ferait osciller la synchro d'un cycle à
l'autre.

## Dossiers vides et permissions

Seuls les dossiers **vides** sont indexés (`kind = 'dir'`) : un dossier peuplé
est implicite, ses fichiers le recréent partout. Piège traité explicitement dans
`planner.ts` : dès qu'un fichier apparaît sous un dossier indexé, son entrée
`dir` devient un fantôme qu'il faut écarter des trois vues — sinon la règle
« présent serveur + absent appareil + baseline concordante » conclurait à une
suppression, qui se propagerait au dossier peuplé des autres appareils. L'agent
retire de son côté les dossiers parents devenus vides après une mise à la
corbeille.

**Un dossier n'a pas de contenu, donc rien à archiver.** L'invariant
« archive-avant-destruction » ne porte que sur ce qui peut être perdu : des
octets. Le hash d'une entrée `dir` est celui du vide, pour lequel aucun blob
n'est jamais écrit, si bien que le faire passer par `archiveCurrent` levait
« blob absent » et **annulait la suppression**. Supprimer un dossier vide était
donc impossible : l'appareil signalait « 1 fichier(s) non synchronisé(s) » à
chaque cycle et le dossier ne partait jamais du serveur. Les trois voies
concernées (`deleteOnServer`, l'hygiène d'index, la restauration de snapshot)
excluent désormais `kind === 'dir'`, comme `uploadFromDevice` le faisait déjà.
Symétriquement, `deleteOnDevice` n'exige pas de preuve d'archivage pour un
dossier : une preuve qui ne peut pas exister le faisait ressusciter sans fin.

Suppressions ordonnées par **profondeur décroissante** entre dossiers (et
croissante à la création) : mettre `a` à la corbeille avant `a/b` emportait
`a/b` avec lui. Le résultat restait correct — la suppression suivante devient un
no-op idempotent — mais la corbeille ne reflétait plus ce qui avait été demandé.

Le `mode` Unix (`& 0o777`) est transporté et réappliqué sur Linux/macOS. Un
agent Windows annonce `null`, que le serveur interprète comme « je ne sais pas »
et qui **conserve** la valeur en base : sans cette règle, un aller-retour par
Windows effacerait le bit exécutable d'un script pour toute la flotte. Un `chmod`
seul ne change pas le hash : il passe par `plan.modeChanges`, sans transfert.

**Le propriétaire, lui, n'est pas transporté — il est ADOPTÉ.** L'agent tourne
le plus souvent en root (service système) : tout ce qu'il crée appartiendrait
donc à root, et l'utilisateur se retrouverait avec, dans son propre dossier, des
fichiers qu'il ne peut ni modifier ni supprimer. Chaque fichier installé et
chaque dossier créé prend donc le propriétaire de la RACINE du partage
(`adopt_owner`, `lchown` pour ne jamais suivre un lien).

Le symptôme était sournois : un fichier simplement DÉPLACÉ garde son
propriétaire d'origine, donc seuls les fichiers réellement téléchargés
basculaient. Le dossier paraissait sain jusqu'à ce qu'on bute sur l'un d'eux.

Corollaire à ne pas rater : on ne pousse **rien** vers un appareil qui annonce
`null`. Lui envoyer le mode serveur rejouerait le même ordre à chaque session,
indéfiniment (son scan suivant annoncerait toujours `null`) — un aller-retour par
fichier, pour rien. Et `sync.applyDir` porte un `kind` : un `chmod` sur un fichier
momentanément absent ne doit pas faire naître un DOSSIER à sa place, que le
planner écarterait ensuite pour toujours en « conflit de nature ».

## Déplacements et renommages

Un renommage se lit comme « suppression ici + ajout là du MÊME hash ». Le
planner **apparie ces deux moitiés** (`plan.moves`) au lieu de les traiter
séparément, ce qui change tout : un déplacement ne crée alors **ni version
serveur, ni entrée de corbeille chez les pairs**. Traité en deux temps, il
coûtait deux copies intégrales du fichier pour une opération qui ne détruit
rien — c'est ce qui faisait gonfler la corbeille.

Chez l'appareil source, il n'y a que l'index à recoller (le fichier a déjà
bougé). Chez les pairs, le serveur envoie `sync.move` et l'agent **renomme sur
place**, après avoir vérifié que la source porte bien le contenu attendu. Un
échec retombe sur le chemin ordinaire, qui reste sûr.

Distinction qui compte : on ne renomme que si le contenu QUITTE son ancien
chemin. S'il y reste (une copie), c'est une copie locale — sans quoi on
détruirait l'original.

Et une suppression n'est sautée que sur un renommage **constaté**, jamais sur
l'intention d'en faire un : un renommage peut échouer (cible occupée, fichier
verrouillé), et sauter la suppression dans ce cas laisserait le fichier sur le
disque avec sa baseline effacée — donc plus jamais repris par aucune session.

**Corollaire sur l'invariant anti-perte** : un déplacement ne laisse
volontairement aucune version. La preuve d'archivage qu'exige `deleteOnDevice`
accepte donc aussi qu'un contenu soit encore VIVANT ailleurs dans l'index.
Faute de quoi l'optimisation des déplacements condamnait chaque pair à
ressusciter l'ancien chemin à chaque cycle, indéfiniment.

Et aucun octet ne traverse le réseau dans les deux cas :
- **montée** : si le blob store possède déjà ce hash, l'upload est sauté (le CAS
  garantit que le blob de ce hash *est* ce contenu) ;
- **descente** : si la baseline de l'appareil montre qu'il détient déjà ce
  contenu à un autre chemin, le serveur envoie `sync.applyLocal` et l'agent
  copie en local après avoir **vérifié le hash de la source**. Tout échec
  retombe sur le téléchargement chunké normal.

## Sauvegardes point-in-time (`sync_snapshots`)

`sync_versions` est une corbeille **par fichier** ; un snapshot est un point de
restauration du **partage entier** (« remets le dossier comme il était mardi »).

- Il ne copie **aucun octet** : c'est un `INSERT ... SELECT` de l'index vivant,
  les contenus étant déjà dédupliqués par hash.
- **Il épingle donc ses blobs.** `syncFiles.isHashReferenced` interroge les
  TROIS référents (index vivant ∪ versions ∪ snapshots) — sans ce troisième
  `EXISTS`, la purge des versions détruirait des contenus qu'un snapshot est
  seul à détenir, et la restauration échouerait le jour où on en a besoin.
- Cadence et rétention par partage (`snapshot_*`), pris par le prune horaire
  quand l'index a réellement bougé. Rétention grand-père/père/fils : tout sur
  48 h, puis un par jour sur 30 jours, puis un par semaine. Les snapshots
  `manual` et `preRestore` échappent à la purge par l'âge.
- **Restauration réversible** : un snapshot `preRestore` de l'état courant est
  pris d'abord, donc annuler revient à le restaurer. Elle est refusée en bloc si
  un seul contenu manque au stockage (vérifié AVANT toute mutation) ; elle
  n'emprunte aucune voie nouvelle vers le disque (`archiveCurrent` → `upsert` /
  `markDeleted`), puis les appareils convergent par le chemin normal.

## Reprise des gros transferts

Une coupure ne fait plus repartir de zéro, dans les deux sens.

**Descente** : le temporaire de l'agent est nommé par **hash** et non par `opId`,
donc retrouvable au cycle suivant. Le serveur ouvre par `sync.applyStart`,
l'agent répond `applyReady` avec les octets déjà en place, et seul le manque est
renvoyé (`store.read(hash, skipBytes)`).

**Le serveur tranche, l'agent obéit** : l'offset retenu est répété dans chaque
frame `sync.applyChunk` (`resumeFrom`) et l'agent tronque son temporaire à cette
valeur. Il ne doit jamais présumer de son propre point de reprise — les deux
côtés compteraient alors des octets différents, et l'installation échouerait sur
un « contenu reçu invalide » après un transfert entier gâché.

**Montée** : le `.part` serveur porte le format de blob **`0x02`, scellé par
blocs** de 1 Mio (nonce dérivé d'un compteur, AAD = compteur + marqueur de fin
qui ferme la troncature). Reprendre = compter les blocs complets et les relire
EN LOCAL pour reconstituer le SHA-256 courant, sans qu'un octet ne retraverse le
réseau. `sync.push` porte alors un `startOffset`.

Le format `0x01` (flux GCM unique) reste **lu pour toujours** : l'octet de
version de l'en-tête les distingue. Aucune migration de blobs, aucun
re-chiffrement. C'est ce que verrouille `blobStore.test.ts`.

Un fichier modifié entre-temps a un autre hash, donc un autre partiel : la
reprise est **auto-corrective**, aucune reprise sur des octets périmés n'est
possible. Corollaire : `ShareBlobStore.init()` ne vide plus `tmp/` à l'aveugle,
il ne balaye que les partiels abandonnés (> 7 j) et les temporaires anonymes.

## Intégrité du stockage

Le store vérifie déjà tout à la lecture, mais une corruption au repos ne se
découvrirait alors qu'au moment d'une restauration — le pire moment. Deux
déclencheurs vont donc au-devant (`src/cloudSync/integrity.ts`) :

- bouton **« Vérifier l'intégrité »** (passage complet, `cloudSync.verifyIntegrity`) ;
- **balayage de fond**, activé par défaut : `INTEGRITY_BUDGET_BYTES` par tour de
  prune horaire, curseur dans `sync_meta`, donc tout finit couvert sans se faire
  remarquer.

**Auto-réparation** : un blob corrompu qu'un appareil EN LIGNE détient encore
d'après sa baseline est simplement redemandé et réécrit. Sinon l'anomalie part
au journal et en audit.

## Débit, corbeille, et ce qui n'est jamais synchronisé

Limites de bande passante par partage (`rate_up_bps` / `rate_down_bps`, `NULL` =
illimité, le défaut). Le limiteur vit **chez l'émetteur** : serveur pour les
descentes (`src/cloudSync/rateLimit.ts`), agent pour les montées (valeur poussée
dans `sync.config`) — brider le récepteur ne ferait que gonfler les tampons.
`trash_keep_days` règle la rétention de `.deveye-trash/`.

Ne sont **jamais** synchronisés, et l'interface le dit dans le dialogue
Exclusions : liens symboliques, liens durs (chaque copie devient un fichier
indépendant), fichiers creux (recopiés pleins), ACL et attributs étendus. Seuls
les bits de permission Unix passent.

## Une seule instance à la fois

Un verrou distribué par partage **empirerait** les choses : une session est un
dialogue multi-aller-retour sur la WebSocket de l'agent, épinglée au processus
où il s'est connecté. Une instance qui gagnerait le verrou sans détenir la socket
ne synchroniserait rien, en silence.

`src/cloudSync/lease.ts` pose donc un **bail** (clé `sync_meta`). Un second
processus démarre en **mode passif** : lectures servies, mais aucune session,
aucune purge, aucun GC, et surtout **pas de `failStale`** — qui aurait passé en
erreur toutes les sessions vivantes du premier. Les commandes mutantes passent
par `requireActiveEngine` et refusent franchement.

**L'identité est celle de l'EMPLACEMENT, pas de l'exécution** (hôte + dossier de
travail + PID, hachés). C'est le point qui compte : un conteneur tué par
`SIGKILL` (OOM, délai de grâce Docker dépassé) ne libère rien, et avec une
identité aléatoire le processus suivant ne reconnaissait pas « son » bail —
la synchro restait morte jusqu'à expiration, ce qui est arrivé en production.
Un redémarrage au même endroit reprend donc la main immédiatement.

Le bail est aussi rendu à l'arrêt propre, le TTL (3 min) ne servant plus qu'au
déplacement d'instance. Et le battement tourne **même en mode passif** : c'est
lui qui reprend la main dès l'expiration, faute de quoi une instance passive le
resterait pour toujours. En reprenant, elle relance `scheduleAllActive` pour
rattraper le retard au lieu d'attendre un événement d'agent.

Si le blocage persiste, la sortie de secours est une ligne de SQL :
`DELETE FROM sync_meta WHERE k = 'engine_lease';` puis redémarrage.

`runExclusive` est LE point de couture de tout ce qui mute un partage. Le jour
où une vraie coordination sera nécessaire, c'est le seul endroit à remplacer :
aucune mutation ne doit le contourner.

## Fichiers

- **Types** : `DevEye-Types/src/domain/cloudSync.ts`,
  `features/cloudSync.ts`, protocole agent dans `protocol/agent.ts`
  (`sync.config/scan/push/applyChunk/delete` ↓, `sync.changed/index/chunk/ack/opResult` ↑).
- **Serveur** : `src/cloudSync/` (blobCrypto, blobStore, pathValidation,
  exclusions, planner, versions, session, engine, prune, integrity, rateLimit,
  lease), handlers agent
  `src/agent/handlers/sync.ts`, commandes `src/features/cloudSync/`,
  repos `src/db/repos/sync*.ts`.
- **Agent** : `agent/src/sync/` (paths — `safe_join` est LE portail
  anti-traversée —, scanner, index_cache, watcher, transfer, mod).
- **Client** : `client/src/Features/CloudSync/` (héros d'état, wizard,
  appareils, exclusions, versions, points de restauration, réglages), store
  `client/src/stores/cloudSync.ts`, fusion des appareils `useShareDevices.ts`,
  entrée catalogue `cloudsync`.

## Rafraîchissement de l'interface

Deux sources, et le partage des rôles est la seule chose à retenir :

- le **partage** possède l'attache (dossier local, statut d'attache, dernière
  synchro) — rafraîchi par le sujet live `cloudsync`, et par `devices` puisque
  la liste embarque les appareils attachés ;
- le **store `devices`** possède l'appareil (nom, présence) — recomposé au rendu
  par `useShareDevices`, donc sans aller-retour ni invalidation.

`cloudSync.listShares` embarquait un `deviceName` et un `online` figés à
l'instant de la réponse : renommer un appareil, ou le voir revenir en ligne
après une mise à jour d'agent, n'apparaissait qu'au rechargement de la page.
Recomposer au rendu supprime le problème à la racine plutôt que d'ajouter une
invalidation de plus à maintenir.

La liste des appareils attachables n'est volontairement **pas** filtrée sur la
présence : attacher un appareil hors ligne est légitime (il rattrape à sa
prochaine connexion), et filtrer faisait disparaître de la liste l'appareil
qu'on venait justement de mettre à jour, le temps de son redémarrage.

Le sélecteur de dossier distant prend le même abonnement d'appareil que les
panneaux du Monitoring (`acquireMetrics`). Les réponses de l'agent ne sont
diffusées qu'aux **abonnés** (`hub.publishToSubscribers`) : sans lui, la commande
partait, l'agent répondait, et le serveur jetait sa réponse faute de
destinataire — « Chargement… » à l'infini. L'abonnement se prend avant la
navigation, sinon une réponse rapide arrive avant l'écoute et se perd à son tour.

### Ce qui déclenche un rendu, et ce qui n'en déclenche pas

Trois filtres, chacun à l'endroit où il coûte le moins :

1. **Le serveur ne republie pas un état identique** (`lastState`, comparaison sur
   la charge sérialisée).
2. **Une session sans travail visible ne s'annonce pas.** `isVisible` couvre deux
   cas : le scan à vide (aucun fichier au plan) et, depuis, la **reprise à
   l'identique d'un plan déjà échoué** — reconnue par `planSignature`, une
   empreinte du travail planifié insensible à l'ordre d'énumération. Sans elle,
   un échec permanent faisait osciller le partage entre « synchronisation » et
   « erreur » à chaque cycle, rejouant l'animation de l'icône (`key={state}`
   remonte le composant) : un à-coup visible toutes les deux secondes. Le sursis
   de trois secondes continue de s'appliquer, pour qu'une reprise qui travaille
   vraiment finisse par s'annoncer. L'audit `warning` suit la même règle : le
   même échec, tour après tour, ne vaut qu'une entrée.
3. **Le store client ne notifie que sur changement réel**, champ par champ
   (`sameProgress`, `applyState`). `sessionId` est délibérément exclu de la
   comparaison : il change à chaque tentative, y compris quand rien de visible
   n'a bougé.

L'ordre importe : chaque filtre traite une cause différente, et aucun ne masque
un vrai changement d'état. Réduire les rendus sans traiter la cause en amont
donnerait une interface qui ne suit plus.

Deux règles complètent le tableau, sur la ligne du fichier en cours :

- `currentPath` n'est **pas** vidé entre deux fichiers. Le pas suivant l'écrase,
  la fin de session l'efface. Le vider faisait alterner le flux publié entre
  « ce fichier » et « aucun fichier », et la ligne clignotait une frame sur deux.
  Ce que l'interface lit, c'est le dernier fichier touché par la session.
- Les lignes de progression ont une **hauteur réservée** en CSS (`1.4em`) et sont
  toujours rendues, même vides. Une ligne momentanément sans contenu s'effondrait
  à zéro, changeait la hauteur de la carte et déplaçait les boutons.

### État agrégé : ce que « hors ligne » veut dire

`offline` décrit le **partage**, pas un appareil : il ne vaut que si plus rien ne
peut se synchroniser, donc si *aucun* appareil actif n'est joignable. Tant qu'il
en reste un, le partage fonctionne et son état est celui de son contenu, l'absent
étant nommé en détail. Le prendre dès le premier appareil absent était trompeur :
sur deux machines dont une éteinte, le partage restait bloqué sur « appareil hors
ligne » alors qu'il était parfaitement à jour.

### Ordre des cartes

`sort_order` sur `sync_shares` (migration `083`), rangé par `cloudSync.reorderShares`
et par rien d'autre ; un nouveau partage prend le rang suivant, donc la fin de la
liste. La commande envoie la liste **complète** dans son ordre final, ce qui la
rend idempotente et réparatrice : deux partages ayant hérité du même rang se
départagent au premier déplacement. Elle n'exige pas le bail d'instance, parce que
ranger sa liste ne touche ni fichier, ni index, ni session.

Les flèches sont posées en **absolu** dans le coin de la carte : la disposition
est identique avec ou sans elles. Pas de glisser-déposer ici, contrairement aux
autres écrans, parce que les cartes sont hautes et qu'un glissement sur cette
hauteur est pénible.

## Tests

`npm test` (runner natif de Node via `tsx`) couvre la pièce PURE, celle dont
dépend l'invariant : `src/cloudSync/planner.test.ts` (premier sync sans
baseline, résurrection, conflits, dossier vide qui se remplit, `chmod`,
collisions de casse, déplacement), `pathValidation.test.ts` (noms Windows,
NFC/NFD) et `prune.test.ts` (rétention des snapshots). Côté agent,
`cargo test sync::` reprend les mêmes jeux de noms — les deux règles doivent
rester d'accord — et couvre le seau à jetons de montée et la relecture d'un
partiel.

`blobStore.test.ts` mérite une mention à part : il verrouille la **lecture des
blobs `0x01`**. Si ce test tombe, des données déjà sur disque sont devenues
illisibles.

## Test E2E local

Deux agents sur une machine via `DEVEYE_CONFIG` (deux configs + deux dossiers
locaux), un partage vers un dossier de brouillon, puis : merge initial,
propagation watcher, conflit d'édition double (perdant visible dans Versions),
suppression propagée (version serveur + `.deveye-trash` chez le pair),
pause/reprise aux deux niveaux, coupure serveur mi-transfert puis relance
(convergence), restauration/téléchargement d'une version, purge auto avec une
petite limite.

À vérifier en plus, avec un **vrai Windows** dans la boucle :
- `aux.txt` créé sur Linux : refusé proprement, journalisé une seule fois, et
  les trois dossiers restent identiques ;
- un dossier vide créé sur macOS, rempli sur Windows, puis vidé sur Linux ;
- un script `+x` en aller-retour Linux → Windows → Linux, bit conservé ;
- un déplacement de dossier volumineux : aucun octet sur le fil, aucune version
  créée ;
- un fichier ouvert et verrouillé sous Windows pendant qu'une mise à jour
  arrive (réessais, message d'avertissement, pas de partage au rouge) ;
- une restauration de snapshot, puis son annulation via le point `preRestore` ;
- couper le serveur au milieu d'un transfert de plusieurs Go, relancer, et
  vérifier dans les Logs que la reprise repart de l'offset et non de zéro ;
- abîmer un blob à la main et vérifier que le balayage le détecte puis le répare
  depuis un appareil en ligne ;
- démarrer un second processus serveur et vérifier qu'il annonce le mode passif
  sans toucher aux sessions du premier.
