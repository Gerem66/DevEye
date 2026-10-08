# Sauvegardes

Copies programmées de ce que DevEye détient, vers un endroit qui n'est pas le
serveur qui les produit.

Module in-repo (`features/backup`) : contrats dans `src/contracts/`, moteur et
handlers dans `src/server/`, écrans dans `src/client/`. L'app ne garde que
l'identité (`backup` dans le registre publié). Les sources viennent des modules
qui les détiennent, chacun par un contrat publié par son service : Bases de
données (`DATABASE_BACKUP_PROVIDER`), Serveur mail
(`MAILSERVER_BACKUP_PROVIDER`), CloudSync et Hébergement
(`CLOUDSYNC_BACKUP_PROVIDER`, `HOSTING_BACKUP_PROVIDER`, le même contrat
d'arborescence `TreeBackupProvider`).

Trois notions, et la séparation est la feature elle-même :

| Notion          | Ce que c'est                                   | Fréquence de changement |
| --------------- | ---------------------------------------------- | ----------------------- |
| **Destination** | Un endroit qui accepte des octets              | On la déclare une fois  |
| **Travail**     | Quoi sauvegarder, où, quand, combien de copies | Rarement                |
| **Exécution**   | Ce qu'un travail a produit une fois            | À chaque passage        |

Les croiser est tout l'intérêt : la même base part vers le Raspberry **et** vers
un S3 distant en déclarant deux travaux, sans dupliquer la configuration
d'accès.

Les destinations se gèrent à l'échelle de la fonctionnalité, dans Réglages →
**Destinations**, l'onglet des sources de la coquille sous le nom que lui donne
le registre (voir [Docs/SOURCES.md](../../Docs/SOURCES.md)) ; un travail se crée
par le dialogue de la vue puis se règle dans sa fiche : onglet **Général** (ce qui
part, où, à quelle cadence, combien de copies, actif ou non, suppression) et
onglet **Chiffrement** (la forme des archives à venir).

---

## Les destinations

### `local` : sur le serveur

Dans le magasin d'objets de l'hôte (`deps.objects`) : son disque sous
`BACKUP_STORAGE_DIR` (`/data/backups` par défaut), ou son bucket S3
(`STORAGE_S3_*`) sous `<préfixe>/backup/`, cloisonné par espace (`ws-<id>/`). Le
plus simple à mettre en route. Une exécution ne garde que la clé de son archive
(`ws-<id>/<dossier>/<nom>`), jamais l'endroit où elle se résout : l'arbre se
recopie sur un autre disque ou dans un autre bucket, et ses archives s'y relisent
telles quelles.

⚠️ **Sans bucket, elle vit sur le même disque que ce qu'elle sauvegarde.** Elle
protège d'une erreur logicielle (une table effacée, une migration ratée), jamais
d'une panne de la machine. C'est un premier palier, pas le seul.

En conteneur, la paire hôte/conteneur suit exactement celle de CloudSync :
`BACKUP_STORAGE_ROOT` est le dossier de l'hôte (source du montage),
`BACKUP_STORAGE_DIR` ce même dossier vu par le serveur. Les confondre revient à
écrire dans la couche d'écriture du conteneur, donc à perdre les archives au
redéploiement suivant : c'est refusé. Sur une racine qu'aucun volume ne porte
(`objects.ephemeralRoot()`), le contrôle de la destination échoue, chaque
exécution aussi, avec la phrase qui nomme `BACKUP_STORAGE_DIR`
(`hostedStorageProblem`), et le démarrage l'écrit au journal.

Sur une instance avec le module de facturation, l'espace occupé « sur le
serveur » est compté par l'offre du propriétaire (quota `storage`, voir
[Offre et droits](#offre-et-droits)) ; les destinations vers un stockage qui
n'est pas le serveur ne sont pas comptées.

### `device` : un dossier d'une machine enrôlée

L'agent écrit le fichier. C'est ce qui fait d'un Raspberry Pi, d'un NAS ou d'un
vieux portable une cible de sauvegarde **sans rien y installer** : l'agent y
tourne déjà.

La destination n'use que des ordres de l'explorateur de fichiers :
`files.upload` (écriture d'un fichier par morceaux à un offset) et
`files.mutate` (`mkdir`, `rename`, `delete`). Tout agent qui sert l'explorateur
sait donc recevoir une archive.

Le serveur pousse par trames de 512 Kio et surveille le tampon d'envoi de la
socket (`deps.agents.buffered`) : sans cette contre-pression, la mémoire du
serveur suivrait la taille de l'archive au lieu de celle d'un morceau.

L'archive est écrite sous `<nom>.part` puis renommée. Un transfert coupé ne
laisse donc jamais un fichier qui **a l'air** complet : c'est la seule propriété
qui compte vraiment ici : une archive tronquée qui passe pour entière est pire
qu'une archive absente, parce qu'on croit être couvert.

### `s3` : un service compatible S3

Garage, MinIO, Scaleway, Backblaze, AWS. Avec SFTP et WebDAV, l'une des trois
destinations qui sortent les octets de la machine.

Le client S3 est celui de l'hôte, `src/Services/objectStorage/s3.ts`, partagé
avec son magasin d'objets : signature SigV4, `PUT` simple en dessous de 16 Mio
(`S3_PART_BYTES`), envoi multiple au-delà, avec abandon explicite en cas
d'échec (S3 facture les parties d'un envoi jamais terminé, et elles sont
invisibles au listage).

Le point qui casse en premier sur une première configuration est l'**adressage**
: `pathStyle` (`https://hôte/bucket/clé`) pour un service auto-hébergé, virtuel
(`https://bucket.hôte/clé`) pour AWS. D'où un commutateur explicite plutôt
qu'une devinette sur le nom d'hôte.

#### Faire d'un Raspberry Pi un serveur S3

**Garage** est le meilleur choix sur un Pi : écrit en Rust, conçu pour le
self-hosting multi-sites, bien plus léger que MinIO.

```bash
# Sur le Pi, avec une partition ou un dossier dédié :
sudo mkdir -p /mnt/backup/{data,meta}

# garage.toml
metadata_dir = "/mnt/backup/meta"
data_dir     = "/mnt/backup/data"
replication_factor = 1          # 1 seul nœud
rpc_bind_addr = "[::]:3901"
[s3_api]
api_bind_addr = "[::]:3900"
s3_region     = "garage"
```

Puis un service systemd, `garage layout assign` pour le nœud, et
`garage key create deveye` qui rend la paire (clé d'accès, clé secrète) à coller
dans DevEye. Adressage **par chemin**, région `garage`.

Le bouton **Contrôler** d'une destination (`backup.destinationTest`) écrit,
relit et efface un objet témoin : lister un bucket ne prouve pas qu'on peut y
écrire, et découvrir le contraire à 3 h du matin est exactement ce que ce bouton
existe pour éviter.

### `sftp` : un serveur SSH

Un NAS, un VPS, un Synology : tout ce qui parle SSH, sans rien y installer.
Connexion par mot de passe ou par clé privée (sans phrase de passe, comme
Bases de données). L'archive est écrite sous `<nom>.part` puis renommée, avec
l'extension `posix-rename` d'OpenSSH quand le serveur l'offre, sinon en
effaçant d'abord l'ancienne.

**L'empreinte du serveur est retenue au premier contrôle réussi**, et rien ne
part vers un serveur qu'aucun contrôle n'a validé : sans elle, quiconque
détourne le nom d'hôte reçoit les archives. Une empreinte qui change arrête
tout, en la nommant ; le bouton **Oublier** de la destination sert au serveur
réinstallé. Changer d'hôte ou de port l'oublie aussi.

La connexion passe par le garde des appels sortants (`assertAllowedOutboundHost`
puis `publicLookup` sur le socket remis à ssh2) : une adresse privée n'est
joignable que sur une installation qui les ouvre (`OUTBOUND_ALLOW_PRIVATE`).

### `webdav` : Nextcloud, Synology, kDrive

`MKCOL` du dossier, `PUT` en flux vers `<nom>.part` sans longueur annoncée,
puis `MOVE` vers le nom final. Tout passe par `safeFetch`, sans suivre de
redirection : un corps en flux ne se rejoue pas, et une adresse qui redirige
est une adresse à corriger.

Le contrôle envoie son témoin **par le même envoi en flux** qu'une archive : un
serveur qui refuse l'envoi par morceaux (certains proxys exigent la longueur)
échoue au contrôle, pas à 3 h du matin. Les quotas viennent de la RFC 4331
quand le serveur la connaît.

Le mot de passe voyage en en-tête `Basic` : l'adresse doit être en `https`,
sauf vers une adresse privée qu'une installation personnelle a ouverte.

---

## Les sources

Le sélecteur « Quoi sauvegarder » range les sources par catégorie, dans l'ordre
des sections qui suivent. **Chaque catégorie offerte s'affiche, même vide**, avec
« Aucun » sous son titre : on voit ce qui se sauvegarde avant d'en avoir. La
commande `backup.sources` rend ces catégories (`kinds`) à côté des candidats :
une source dont le module manque à l'instance n'en fait pas partie, et
« DevEye » n'existe que pour un administrateur. Pendant une recherche, les
catégories vides s'effacent.

### `deveye` : la base MySQL de DevEye

**C'est la sauvegarde à avoir si on n'en a qu'une.** Elle couvre tout ce qui vit
en base, c'est-à-dire presque tout : notes, mots de passe, projets, historique de
supervision, index CloudSync, comptes mail, finances, constats Sentinelle. Pas
les fichiers : ceux des partages CloudSync, les messages du Serveur mail et les
dossiers hébergés vivent sur le disque ou dans le magasin d'objets, chacun avec
sa propre source.

Elle porte **tous les comptes de l'instance** : seul un administrateur global la
voit, et il ne la choisit que depuis son espace personnel, où personne d'autre
ne peut modifier la destination de ses archives ; ailleurs, elle reste grisée
avec sa raison. Le serveur le vérifie à la création comme à la modification
d'un travail. Pour la même raison, une archive de cette source ne sort jamais
dans l'export d'un seul compte.

C'est aussi la raison pour laquelle il n'existe **pas** de source « Appareils » :
les relevés d'appareils sont des lignes de `device_metrics`, elles sont déjà
là-dedans. Les sauvegarder séparément reviendrait à les copier deux fois.

### `database` : une base supervisée de l'espace

Passe par le **même accès** que la supervision, tunnel SSH, proxy SOCKS ou
appareil compris : le module ne déchiffre aucune connexion, il demande à Bases
de données un accès ouvert (`DATABASE_BACKUP_PROVIDER`, `openAccess`, lu par
`deps.providers.get`), que le module Bases de données construit avec
`DatabaseMonitor.targetOf` (`features/database/src/server/service.ts`) et son
tunnel, et referme quand le flux s'achève. Une base joignable par Bases de
données est donc sauvegardable sans configuration supplémentaire.

### `mailbox` : une adresse du Serveur mail

Les messages vivent hors base, un fichier chiffré par message sous la clé de
leur boîte : la base de DevEye n'en porte que l'index. L'archive les rend **en
clair**, en **Maildir++**, la disposition de Dovecot et de docker-mailserver :

```
contact@exemple.fr/
  subscriptions                 les dossiers abonnés
  dovecot-keywords              les mots-clés IMAP d'INBOX
  cur/  new/  tmp/              INBOX
  .Envoy&AOk-s/                 un dossier : nom en UTF-7 modifié, `/` → `.`
    maildirfolder  cur/  new/  tmp/
```

Chaque message est un fichier RFC 822 lisible, nommé
`<date>.M<id>.deveye,S=<taille>:2,<drapeaux>` : ses drapeaux (`DFRST`) et les
lettres de ses mots-clés survivent, et l'archive se dépose telle quelle dans le
dossier mail d'un Dovecot, qui la sert sans conversion. DevEye ne réimporte pas :
on recopie ensuite vers lui par IMAP. Ce que l'archive a dû écarter est dit sur
l'exécution : un message effacé entre la liste et la lecture, un point dans un
nom de dossier (le séparateur Maildir++, devenu `_`), un mot-clé au-delà des 26
lettres d'un dossier.

**Un droit de plus, revérifié à chaque passage.** Le courrier ne se lit pas dans
l'interface : seul celui qui peut changer le mot de passe de l'adresse y entre.
Créer ou modifier un tel travail demande donc, dans Serveur mail, l'écriture
**et** « Gérer les mots de passe » sur cette adresse (`authorize` du contrat).
L'enregistrer en fait l'auteur, et le moteur relit ses droits avant chaque
passage, comme pour un dossier de machine.

### `cloudsync` et `hostingFolder` : les fichiers d'un partage ou d'un dossier hébergé

Rendus **en clair** dans une archive `tar`, arborescence d'origine reconstituée
depuis l'index du module, par le même contrat d'arborescence
(`TreeBackupProvider`) : `CLOUDSYNC_BACKUP_PROVIDER` pour un partage,
`HOSTING_BACKUP_PROVIDER` pour un dossier hébergé. Un fichier illisible est
complété par des zéros pour que le `tar` reste valide, et compté sur
l'exécution ; un dossier vide reste au sélecteur, grisé.

L'archive doit pouvoir s'extraire par `tar -xzf` sur une machine où DevEye n'a
jamais tourné : copier le magasin tel quel (des contenus chiffrés adressés par
condensé ou par identifiant) aurait produit un répertoire technique
inutilisable sans le reste du système.

Un partage chiffré de bout en bout n'est pas proposé : le serveur n'a pas de quoi
le lire, le contrat de CloudSync ne le liste pas et ne le retrouve pas. Sa
sauvegarde se fait depuis une machine qui le synchronise (source
`deviceFolder`). D'un dossier hébergé, seuls les fichiers reçus en entier
partent ; ses adresses publiques et ses réglages sont dans la base de DevEye.

### `deviceFolder` : les fichiers d'une machine

Un dossier d'une machine enrôlée (un site, `/etc`, des volumes Docker),
archivé **par son agent** en `.tar.gz` : l'ordre `files.archive` construit
l'archive sur la machine, avec les exclusions du travail (les mêmes règles
que CloudSync), et le serveur la tire morceau par morceau
(`deps.agents.archiveFolder`). Elle ne se recompresse pas en route.

**L'agent n'envoie que ce que le serveur a pris.** Chaque morceau dépense un
crédit ; le serveur en accorde huit d'avance et les rend par quatre, au rythme
où la destination absorbe. Une destination lente freine la machine au lieu de
remplir la mémoire du serveur, et un travail abandonné (délai dépassé,
destination en panne) annule l'archive sur la machine. Un agent qui ne connaît
pas l'ordre ne déclare pas `folderArchive` dans son rapport : la machine
apparaît grisée « agent à mettre à jour ».

**Deux droits, revérifiés à chaque passage.** Créer ou modifier un tel travail
demande la permission « Sauvegarder les fichiers d'une machine » de
Sauvegardes, et la permission « Explorateur de fichiers » d'Appareils sur cette
machine (surcharges de l'élément comprises : qui peut tout télécharger à la main
peut le sauvegarder). L'enregistrer en fait l'auteur ; le moteur relit ses
droits sans session avant chaque passage (`deps.access`), et le travail échoue,
en le disant, le jour où il ne les a plus, ne serait-ce que parce qu'il a quitté
l'espace. Sans cela, un ancien membre qui avait choisi son propre S3 comme
destination continuerait de recevoir les fichiers de la machine.

Le dossier, ses exclusions et l'auteur vivent dans le `content` chiffré du
travail : un chemin dit ce qu'on garde, comme un bucket. Une machine
supprimée fait échouer le passage avec sa raison.

Ce que l'archive laisse de côté est dit sur l'exécution, pas tu : les éléments
illisibles, et les fichiers modifiés pendant la lecture (archivés à la taille
annoncée, complétés ou coupés : la structure du `tar` reste lisible, leur
contenu peut être déchiré). Pour une base de données, on passe par sa source.
Les liens symboliques sont gardés comme liens ; les liens durs sont dupliqués,
les fichiers creux recopiés pleins ; sous Windows, pas de cliché VSS, un
fichier verrouillé est ignoré.

Si la destination est un dossier de la même machine situé sous le dossier
sauvegardé, il est exclu d'office ; si c'est le dossier même, le passage est
refusé. Une machine qui héberge DevEye doit exclure le dossier de ses
sauvegardes à la main : le lien entre les deux ne se voit pas d'ici.

### `dockerVolume` : un volume Docker ou Podman d'une machine

Un dossier de machine, désigné par ce qu'il est plutôt que par son chemin : le
travail retient la machine, le moteur et le nom du volume, et relit son
`mountpoint` dans l'inventaire de l'agent (`agents.dockerInventory`) **à chaque
passage**. Un `data-root` déplacé ne casse donc rien, et un volume disparu fait
échouer le passage en le nommant. L'archive est ensuite celle d'un dossier :
même agent, mêmes deux droits revérifiés, même exclusion d'une destination
écrite dessous, sans autre exclusion et sans quitter le système de fichiers.

Le sélecteur liste les volumes de pilote `local` des machines permises **et en
ligne** (cinq secondes pour répondre, sans quoi la machine n'en apporte aucun ;
un travail existant garde le sien affiché, « hors ligne »). Un volume Docker vit
sous `/var/lib/docker` : un agent qui ne tourne pas en administrateur ne le lit
pas, et ce volume est grisé avec sa raison. Un volume Podman sans racine vit chez
l'utilisateur de l'agent, qui le lit.

Copier les fichiers d'une base en train d'écrire donne une base déchirée : pour
une base dans un conteneur, on passe par sa source Bases de données.

---

## Le vidage des bases : `mysqldump` / `pg_dump`

Écrits par ces outils-là, jamais par DevEye. Un vidage juste doit reproduire les
vues, les procédures, les déclencheurs, les séquences, l'ordre d'insertion imposé
par les clés étrangères et l'échappement exact de chaque dialecte, et surtout
produire un fichier qui se restaure par `mysql <` ou `psql <`, **sans DevEye**.
Une sauvegarde qui exige son producteur pour être relue n'en est pas une.

Les deux binaires sont installés dans l'image (voir `Dockerfile`). Leur absence
est signalée par une phrase qui les nomme, jamais par un `ENOENT` nu.

Le mot de passe passe par l'environnement (`MYSQL_PWD`, `PGPASSWORD`), jamais par
`argv` : la ligne de commande d'un processus est lisible par tout le système.

---

## Chiffrement : ce qu'il faut absolument comprendre

Les archives sont scellées au **même format que les blobs CloudSync** (`DEVB`
v2 : AES-256-GCM par blocs de 1 Mio, nonce dérivé du rang, AAD portant le rang et
un marqueur de fin). Le format vit dans le SDK (`@deveye/types/sdk`, `devb.ts` :
`sealStream`, `openSealedStream`), seul endroit que deux modules partagent.

La **clé**, en revanche, n'est pas celle de CloudSync, et la différence est
vitale :

```
BAK = HKDF-SHA256(serverKey, salt='deveye-backup', info='v1', 32)
serverKey = SHA-256("CRYPT_KEY_A:CRYPT_KEY_B")
```

Elle est **dérivée, jamais stockée** (`deps.keys.derive`, la dérivation du
SDK). La BMK de CloudSync est rangée wrappée dans la table `sync_meta` :
l'utiliser ici aurait mis la clé qui déchiffre l'archive _à l'intérieur_ de
l'archive. Le jour où on restaure, c'est-à-dire le jour où la base a disparu, on
n'aurait aucun moyen de l'ouvrir.

> ⚠️ **`CRYPT_KEY_A` et `CRYPT_KEY_B` sont la sauvegarde.**
> Sans elles, une archive chiffrée est un fichier de bruit. Elles se rangent là
> où l'on range une clé, et surtout pas à côté des archives ni sur la machine
> qu'elles protègent. Les changer rend illisibles toutes les archives d'avant.

Le chiffrement est un réglage **du travail** : `backup_jobs.encryption`, `none`
ou `server`, réglé dans l'onglet Chiffrement des réglages du travail. Une
destination dit où écrire, le travail dit sous quelle forme. La forme reste
recopiée sur chaque exécution au moment où elle part (`backup_runs.encrypted`) :
changer le réglage ne change donc jamais rétroactivement ce qu'on croit des
archives déjà écrites. Un travail naît scellé (`server`), le défaut sûr.

Il n'y a pas de mode « mot de passe », et ce n'est pas un oubli :
l'ordonnanceur tourne sans session, or la clé dérivée du mot de passe ne vit
que dans une session déverrouillée, en mémoire, à fenêtre glissante (voir
[Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md)). Un tel mode ne pourrait
ni tourner planifié, ni survivre à un vidage de plusieurs heures.

### Rouvrir une archive sans DevEye

```bash
node DevEye/scripts/restore-backup.mjs archive.sql.gz.enc
# ou, en lisant les clés dans un fichier :
node DevEye/scripts/restore-backup.mjs --env /chemin/.env archive.sql.gz.enc
```

Ce script n'a **aucune dépendance** (Node seul), aucun accès à la base ni au
réseau, et ignore tout de DevEye au-delà du format d'octets. Il se copie sur une
clé USB avec les archives : c'est même recommandé.

Il affiche le `sha256` du clair, à comparer à celui que DevEye montre sur
l'exécution correspondante : c'est ce qui permet de vérifier une restauration
sans faire confiance à la destination qui a rendu le fichier.

Ensuite :

```bash
gunzip -c archive.sql.gz | mysql -u … -p … base     # source deveye / database (MySQL)
gunzip -c archive.sql.gz | psql  -U … base          # source database (PostgreSQL)
tar -xzf archive.tar.gz                             # source cloudsync / deviceFolder
```

---

## L'ordonnanceur

Même forme que les autres services de fond : un ticker du SDK
(`deps.createTicker`), démarré par le service du module (`BackupEngine`), qui
cherche les travaux dus toutes les `BACKUP_TICK_SECONDS` (60 s). Un travail est
`manual`, `hourly`, `daily`, `weekly` ou `monthly` ; son échéance se calcule en
heure locale du serveur (`schedule.ts`). Trois différences structurelles avec
les autres services, qui tiennent toutes au fait qu'une sauvegarde **dure** :

1. **Un travail à la fois** : la réservation est prise _avant_ le premier `await`
   (deux clics rapprochés passeraient un contrôle placé après, et lanceraient deux
   vidages simultanés de la même base).
2. **L'échéance est repoussée AVANT l'exécution**, jamais après. Un travail qui
   plante ne doit pas repartir au tour suivant, en boucle, en écrivant des
   archives ratées jusqu'à saturer la destination.
3. **Séquentiel entre travaux** : cinq vidages en parallèle satureraient le lien
   montant. La sauvegarde est le travail de fond qui doit le moins déranger.

Une exécution a un budget, `BACKUP_RUN_TIMEOUT_SECONDS` (6 h) : sans lui, un
agent qui cesse de répondre au milieu d'un dépôt laisserait le travail « en
cours » pour toujours. Les exécutions restées `running` au-delà de ce budget
après un arrêt brutal sont soldées au démarrage (`failStaleRuns`), et
s'affichent « Interrompue : le serveur a redémarré pendant la sauvegarde. ».
Sans ça, un travail resterait « en cours » pour toujours et tous ses passages
suivants seraient sautés en silence.

### Rétention

Après chaque exécution **réussie**, les archives au-delà de `keep_last` sont
effacées de la destination. Un échec n'efface jamais rien.

Une archive qu'on n'arrive pas à effacer (appareil hors ligne, droit manquant)
**reste marquée présente** : la rétention repassera. La marquer effacée alors
qu'elle ne l'est pas ferait grossir la destination sans que rien ne le dise :
la panne qu'on découvre quand le disque est plein.

### Notifications

Ses propres canaux, comme les autres émetteurs, gérés dans Réglages →
Notifications de la coquille commune ; l'envoi passe par la façade du SDK
(`deps.deveyeFor(ws).notify.send(alert, { itemId })` : la route du travail
l'emporte sur celle de la fonctionnalité). **Seuls les échecs sont notifiés** :
sinon le canal se remplirait de succès et l'échec s'y perdrait. La mise en page
Discord est `src/server/notice.ts`, sur les helpers partagés de
`Services/notices/shared.ts` (le seul import de l'app par le module, commenté).
Voir [Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md).

### Une machine comme destination

L'agent écrit par la façade `agents` du SDK (`deps.agents.requestFilesMutate`,
`requestFilesUpload`, `awaitFilesOp`, `buffered` pour la contre-pression) :
les ordres de l'explorateur de fichiers. Écrire sur une machine relève de la
permission « Explorateur de fichiers » d'Appareils, vérifiée à l'ajout, à la
modification et au contrôle de la destination.

---

## Sécurité

Tout vit à l'étage **ouvert** du chiffrement (voir
[Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md)), sans exception :
l'ordonnanceur passe à 3 h du matin, sans session ni mot de passe. Un secret S3
qu'il ne pourrait pas lire serait un travail qui ne part jamais.

La clé étrangère des travaux vers leur destination cascade
(`src/server/migrations/001_job_destination_cascade.sql`) : le refus de retirer
une destination encore visée vit dans le handler (`backup.destinationRemove`,
qui dit combien de travaux bloquent), et la suppression d'un espace ne bute pas
dessus.

Le droit d'espace est `backup`, distinct de `database` exprès. Sa **lecture** est
déjà lourde : la liste des destinations dit _où sont les copies de tout_. Qui la
lit sait quel bucket viser pour obtenir la base entière sans jamais toucher à
DevEye.

En clair en base : `kind`, `device_id`, `source_kind`, le calendrier et les
drapeaux : le strict nécessaire pour que l'ordonnanceur choisisse une branche de
code et trouve les travaux dus sans déchiffrer une seule ligne. Tout le reste
(nom, chemin, endpoint, bucket, identifiant d'accès, message d'erreur, nom de
l'archive) part dans `content`.

La clé secrète S3 ne sort **jamais** : le DTO ne porte qu'un `hasSecret`.

---

## Offre et droits

- **Quota** `storage` (clé `backup.storage` pour le module de facturation) : les
  octets des archives « sur le serveur » des espaces du propriétaire
  (`repo.storedBytesInWorkspaces`), 0 sur l'offre gratuite et 10 Go sur Pro.
  Les sauvegardes vers un stockage qui n'est pas le serveur (machine, S3, SFTP,
  WebDAV) restent libres. Une installation sans module de facturation n'a
  aucune limite.
- **Permissions** : le droit `backup` en lecture et en écriture, plus la
  permission supplémentaire « Sauvegarder les fichiers d'une machine »
  (`deviceFolders`) pour les sources `deviceFolder` et `dockerVolume`, qui
  exigent aussi la permission « Explorateur de fichiers » d'Appareils sur la
  machine (voir [Docs/PERMISSIONS.md](../../Docs/PERMISSIONS.md)). La source
  `mailbox` exige, dans Serveur mail, « Gérer les mots de passe » sur
  l'adresse.
- **Partage** : `shareTier: 'open'` dans le registre publié ; l'entrée `items`
  du serveur donne le domicile et le nom d'un travail à la coquille (partage et
  routes de notification). Pas d'entrée `move`, et ce n'est pas un oubli : un
  travail ne peut pas exister sans destination (`destination_id NOT NULL`), et
  sa destination comme sa source sont des objets de l'espace qu'il quitterait.
- **Export de compte** (`src/server/accountExport.ts`) : destinations, travaux
  et exécutions de l'espace, et les archives « sur le serveur » des sources
  autres que `deveye`, descellées à la volée (voir
  [Docs/ACCOUNT_EXPORT.md](../../Docs/ACCOUNT_EXPORT.md)).

---

## Configuration

Lue dans `src/server/env.ts` (`defineModuleEnv`) :

| Variable                     | Défaut          | Rôle                                                                                   |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `BACKUP_STORAGE_DIR`         | `/data/backups` | la racine des destinations `local`, vue par le serveur ; avec un bucket, le spool seul |
| `BACKUP_TICK_SECONDS`        | `60`            | la cadence à laquelle l'ordonnanceur cherche les travaux dus                           |
| `BACKUP_RUN_TIMEOUT_SECONDS` | `21600`         | le budget d'une exécution (6 h)                                                        |

Et, hors de la spec du module : `BACKUP_STORAGE_ROOT` (le dossier de l'hôte
monté sur `BACKUP_STORAGE_DIR`, dans `docker-compose`), `STORAGE_S3_*` (le
bucket du magasin d'objets de l'hôte), `OUTBOUND_ALLOW_PRIVATE` (les adresses
privées pour SFTP et WebDAV), `CRYPT_KEY_A` / `CRYPT_KEY_B` (la clé des
archives) et `DB_*` (la base de DevEye, pour la source `deveye`). Les défauts
et les commentaires sont dans `.env.template`.

---

## Carte du code

```
deveye-feature.json              id, les trois tables allowlistées (backup_destinations, backup_jobs,
                                 backup_runs), minTypesVersion
src/contracts/domain.ts          destinations, travaux, exécutions, sources, calendriers, lignes SQL
src/contracts/commands.ts        les commandes backup.* : destinations (list, add, update, remove,
                                 test), travaux (list, count, get, add, update, remove, run),
                                 sources, exécutions (runs, runRemove)
src/manifest.ts                  resources, settings (feature: sources ; item: general, encryption),
                                 nativeCapabilities (agents, devices.read, members.read, objects),
                                 extraPermissions (deviceFolders), quotas (storage), links
src/server/index.ts              serverEntry : createRepo, features, migrationsDir, quotas.storage,
                                 accountExport, createService (BackupEngine, le magasin hébergé), items
src/server/env.ts                BACKUP_STORAGE_DIR, BACKUP_TICK_SECONDS, BACKUP_RUN_TIMEOUT_SECONDS
src/server/_shared.ts            Stored*, DTO, le singleton du moteur (setEngine)
src/server/handlers.ts           les handlers des commandes, les droits d'une source et d'une destination
src/server/repo.ts               les trois tables, sur SdkQueryable
src/server/service.ts            BackupEngine : l'ordonnanceur, une exécution, la rétention, l'avis d'échec
src/server/schedule.ts           nextRunAt : la prochaine échéance d'un travail
src/server/sources.ts            ce qu'un travail produit : mysqldump, pg_dump, tar d'une arborescence,
                                 Maildir d'une adresse, archive d'une machine
src/server/maildir.ts            la disposition Maildir++ : noms de dossier, drapeaux, mots-clés
src/server/sinks.ts              écrire une archive : local (magasin d'objets), device, s3, sftp, webdav
src/server/sftp.ts               le client SFTP (ssh2) et l'empreinte du serveur
src/server/webdav.ts             le client WebDAV, sur safeFetch
src/server/tar.ts                un écrivain tar USTAR minimal
src/server/crypto.ts             la clé des archives (BAK), dérivée de la clé du serveur
src/server/notice.ts             la mise en page Discord d'un échec
src/server/accountExport.ts      l'export de compte
src/server/migrations/           001_job_destination_cascade.sql
src/server/*.test.ts             accountExport, handlers, maildir, schedule, service, sftp, sinks, tar,
                                 webdav
```

Le client, `src/client/` :

```
index.tsx                clientEntry : Widget, Full, settingsPanels (sources, general, encryption)
api.ts                   featureApi(manifest)
Backup.tsx               la vue : les travaux et l'état de leur dernier passage
BackupWidget.tsx         la carte de comptage de l'accueil (travaux, dont en échec)
JobDialog.tsx            créer un travail ; une fois créé, il se règle dans sa fiche
JobView.tsx              la fiche d'un travail : ses réglages en tête, son historique dessous
JobGeneralPanel.tsx      Réglages → Général d'un travail
JobEncryptionPanel.tsx   Réglages → Chiffrement d'un travail
JobSourceFields.tsx      la source, et pour une machine son dossier : chemin, exclusions, un seul
                         système de fichiers
SourcePicker.tsx         « quoi sauvegarder », les sources rangées par catégorie, chacune affichée
                         même vide
DestinationsPanel.tsx    Réglages → Destinations : les destinations de l'espace, leur contrôle
DestinationDialog.tsx    ajouter ou modifier une destination, par genre ; l'empreinte SFTP
format.ts, style.module.css
```

---

## Vérification

```bash
npm run test:features        # les tests du module, sur le harnais du SDK (aucune base, aucun serveur distant)
npm run typecheck:features
npm run lint:features
npm run format:check:features
```

---

## Ce qui n'est pas fait, et pourquoi

- **La restauration depuis l'interface.** DevEye montre où sont les archives et
  ce qu'elles valent ; il ne les réinjecte pas. Restaurer une base de production
  est un geste qui se fait les yeux ouverts, avec la main sur le bon serveur,
  pas derrière un bouton d'une application web qui, le jour où l'on en a besoin,
  est peut-être précisément celle qui est tombée.
- **La réplication multi-sites.** Un même travail n'écrit que vers une
  destination. Pour deux copies, on déclare deux travaux, ou l'on confie la
  redondance à Garage, dont c'est le métier (`replication_factor = 2` sur deux
  nœuds, une seule adresse pour DevEye).
- **Une source « Appareils ».** Ces données sont dans la base de DevEye ; les
  sauvegarder à part serait les copier deux fois.
