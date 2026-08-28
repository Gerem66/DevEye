# Sauvegardes

Copies programmées de ce que DevEye détient, vers un endroit qui n'est pas le
serveur qui les produit.

Module in-repo (`features/backup`, huitième native rapatriée sur le SDK des
features, 28 août 2026) : contrats dans `src/contracts/`, moteur et handlers
dans `src/server/`, écrans dans `src/client/`. L'app ne garde que l'identité
(`backup` dans le registre publié) ; le contrat des bases lui vient du module
Bases de données (`features/database/src/server/index.ts`, publié par son
service), sans qu'une ligne de Sauvegardes ait changé à la migration de
celui-ci.

Trois notions, et la séparation est la feature elle-même :

| Notion            | Ce que c'est                                        | Fréquence de changement |
| ----------------- | --------------------------------------------------- | ----------------------- |
| **Destination**   | Un endroit qui accepte des octets                    | On la déclare une fois  |
| **Travail**       | Quoi sauvegarder, où, quand, combien de copies       | Rarement                |
| **Exécution**     | Ce qu'un travail a produit une fois                  | À chaque passage        |

Les croiser est tout l'intérêt : la même base part vers le Raspberry **et** vers
un S3 distant en déclarant deux travaux, sans dupliquer la configuration
d'accès.

---

## Les trois destinations

### `local` — un dossier du serveur

Sous `BACKUP_STORAGE_DIR` (`/data/backups` par défaut), cloisonné par espace
(`ws-<id>/`). Le plus simple à mettre en route.

⚠️ **Elle vit sur le même disque que ce qu'elle sauvegarde.** Elle protège d'une
erreur logicielle — une table effacée, une migration ratée — jamais d'une panne
de la machine. C'est un premier palier, pas le seul.

En conteneur, la paire hôte/conteneur suit exactement celle de CloudSync :
`BACKUP_STORAGE_ROOT` est le dossier de l'hôte (source du montage),
`BACKUP_STORAGE_DIR` ce même dossier vu par le serveur. Les confondre revient à
écrire dans la couche d'écriture du conteneur, donc à perdre les archives au
redéploiement suivant.

### `device` — un dossier d'une machine enrôlée

L'agent écrit le fichier. C'est ce qui fait d'un Raspberry Pi, d'un NAS ou d'un
vieux portable une cible de sauvegarde **sans rien y installer** : l'agent y
tourne déjà.

**Aucune modification de l'agent n'a été nécessaire**, et c'est délibéré : le
protocole porte déjà `files.upload` (écriture d'un fichier par morceaux à un
offset) et `files.mutate` (`mkdir`, `rename`, `delete`) depuis l'explorateur de
fichiers. Un ordre de plus aurait voulu dire recompiler huit cibles et attendre
que toute la flotte se mette à jour avant que la feature ne serve à quelque
chose.

Le serveur pousse par trames de 512 Kio et surveille le tampon d'envoi de la
socket (`MonitorHub.agentBuffered`) : sans cette contre-pression, la mémoire du
serveur suivrait la taille de l'archive au lieu de celle d'un morceau.

L'archive est écrite sous `<nom>.part` puis renommée. Un transfert coupé ne
laisse donc jamais un fichier qui **a l'air** complet — c'est la seule propriété
qui compte vraiment ici : une archive tronquée qui passe pour entière est pire
qu'une archive absente, parce qu'on croit être couvert.

### `s3` — un service compatible S3

Garage, MinIO, Scaleway, Backblaze, AWS. Le seul des trois qui sorte les octets
du réseau local.

Le client S3 est écrit dans `features/backup/src/server/s3.ts` : signature SigV4, `PUT` simple
en dessous de 16 Mio, envoi multiple au-delà, avec abandon explicite en cas
d'échec (S3 facture les parties d'un envoi jamais terminé, et elles sont
invisibles au listage).

Le point qui casse en premier sur une première configuration est l'**adressage**
: `pathStyle` (`https://hôte/bucket/clé`) pour un service auto-hébergé, virtuel
(`https://bucket.hôte/clé`) pour AWS. D'où un commutateur explicite plutôt
qu'une devinette sur le nom d'hôte.

#### Faire d'un Raspberry Pi un serveur S3

**Garage** est le meilleur choix sur un Pi : écrit en Rust, ~50 Mo de RAM, conçu
pour le self-hosting multi-sites. MinIO fonctionne aussi mais tient plutôt
300 Mo.

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

Le bouton « Tester » de DevEye écrit, relit et efface un objet témoin : lister un
bucket ne prouve pas qu'on peut y écrire, et découvrir le contraire à 3 h du
matin est exactement ce que ce bouton existe pour éviter.

---

## Les trois sources

### `deveye` — la base MySQL de DevEye

**C'est la sauvegarde à avoir si on n'en a qu'une.** Elle couvre tout ce qui vit
en base, c'est-à-dire presque tout : notes, mots de passe, projets, historique de
supervision, index CloudSync, comptes mail, finances, constats Sentinelle.

C'est aussi la raison pour laquelle il n'existe **pas** de source « Monitoring » :
les relevés d'appareils sont des lignes de `device_metrics`, elles sont déjà
là-dedans. Les sauvegarder séparément reviendrait à les copier deux fois.

### `database` — une base supervisée de l'espace

Passe par le **même accès** que la supervision, tunnel SSH ou proxy SOCKS
compris : le module ne déchiffre aucune connexion, il demande à Bases de
données un accès ouvert (`DATABASE_BACKUP_PROVIDER`, `openAccess`, lu par
`deps.providers.get`), que le module Bases de données construit avec
`DatabaseMonitor.targetOf` (`features/database/src/server/service.ts`) et son
tunnel, et referme quand le flux s'achève. Une base joignable par Bases de
données est donc sauvegardable sans configuration supplémentaire. L'app
offrait ce contrat tant que la feature était native ; c'est désormais le
service du module qui publie la même clé, et Sauvegardes n'a pas changé
d'une ligne.

### `cloudsync` — les blobs d'un partage

La seule partie de DevEye à ne pas vivre en base. Rendus **en clair** dans une
archive `tar`, arborescence d'origine reconstituée depuis l'index.

L'archive doit pouvoir s'extraire par `tar -xzf` sur une machine où DevEye n'a
jamais tourné : copier le blob store tel quel — des contenus chiffrés adressés
par condensé — aurait produit un répertoire technique inutilisable sans le reste
du système.

---

## Le vidage des bases : `mysqldump` / `pg_dump`

Écrits par ces outils-là, jamais par DevEye. Un vidage juste doit reproduire les
vues, les procédures, les déclencheurs, les séquences, l'ordre d'insertion imposé
par les clés étrangères et l'échappement exact de chaque dialecte — et surtout
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
un marqueur de fin). Le format vit dans le SDK (`@deveye/types/sdk/server`,
`devb.ts`), seul endroit que deux modules partagent.

La **clé**, en revanche, n'est pas celle de CloudSync, et la différence est
vitale :

```
BAK = HKDF-SHA256(serverKey, salt='deveye-backup', info='v1', 32)
serverKey = SHA-256("CRYPT_KEY_A:CRYPT_KEY_B")
```

Elle est **dérivée, jamais stockée** (`deps.keys.derive`, la dérivation du
SDK). La BMK de CloudSync est rangée wrappée dans
la table `sync_meta` : l'utiliser ici aurait mis la clé qui déchiffre l'archive
*à l'intérieur* de l'archive. Le jour où on restaure — c'est-à-dire le jour où la
base a disparu — on n'aurait eu aucun moyen de l'ouvrir.

> ⚠️ **`CRYPT_KEY_A` et `CRYPT_KEY_B` sont la sauvegarde.**
> Sans elles, une archive chiffrée est un fichier de bruit. Elles se rangent là
> où l'on range une clé, et surtout pas à côté des archives ni sur la machine
> qu'elles protègent. Les changer rend illisibles toutes les archives d'avant.

Le chiffrement est un réglage **du travail** (migration 094 ; il a vécu sur la
destination) : `backup_jobs.encryption`, 'none' ou 'server', réglé dans
l'onglet Chiffrement des réglages du travail. Une destination dit où écrire,
le travail dit sous quelle forme. La forme reste recopiée sur chaque exécution
au moment où elle part : changer le réglage ne change donc jamais
rétroactivement ce qu'on croit des archives déjà écrites. Un travail naît
scellé ('server'), le défaut sûr.

Il n'y a pas de mode « mot de passe », et ce n'est pas un oubli :
l'ordonnanceur tourne sans session, or la clé dérivée du mot de passe ne vit
que dans une session déverrouillée, en mémoire, à fenêtre glissante (voir
`SECURITY_MODEL.md`). Un tel mode ne pourrait ni tourner planifié, ni survivre
à un vidage de plusieurs heures.

### Rouvrir une archive sans DevEye

```bash
node DevEye/scripts/restore-backup.mjs archive.sql.gz.enc
# ou, en lisant les clés dans un fichier :
node DevEye/scripts/restore-backup.mjs --env /chemin/.env archive.sql.gz.enc
```

Ce script n'a **aucune dépendance** (Node seul), aucun accès à la base ni au
réseau, et ignore tout de DevEye au-delà du format d'octets. Il se copie sur une
clé USB avec les archives — c'est même recommandé.

Il affiche le `sha256` du clair, à comparer à celui que DevEye montre sur
l'exécution correspondante : c'est ce qui permet de vérifier une restauration
sans faire confiance à la destination qui a rendu le fichier.

Ensuite :

```bash
gunzip -c archive.sql.gz | mysql -u … -p … base     # source deveye / database (MySQL)
gunzip -c archive.sql.gz | psql  -U … base          # source database (PostgreSQL)
tar -xzf archive.tar.gz                             # source cloudsync
```

---

## L'ordonnanceur

Même forme que les autres services de fond : un ticker du SDK
(`deps.createTicker`), démarré par le service du module. Trois différences
structurelles, qui tiennent toutes au fait qu'une sauvegarde **dure** :

1. **Un travail à la fois** — la réservation est prise *avant* le premier `await`
   (deux clics rapprochés passeraient un contrôle placé après, et lanceraient deux
   vidages simultanés de la même base).
2. **L'échéance est repoussée AVANT l'exécution**, jamais après. Un travail qui
   plante ne doit pas repartir au tour suivant, en boucle, en écrivant des
   archives ratées jusqu'à saturer la destination.
3. **Séquentiel entre travaux** — cinq vidages en parallèle satureraient le lien
   montant. La sauvegarde est le travail de fond qui doit le moins déranger.

Les exécutions restées `running` après un arrêt brutal sont soldées au démarrage
(`failStaleRuns`), et s'affichent « Interrompue : le serveur a redémarré ». Sans
ça, un travail resterait « en cours » pour toujours et tous ses passages suivants
seraient sautés en silence.

### Rétention

Après chaque exécution **réussie**, les archives au-delà de `keep_last` sont
effacées de la destination. Un échec n'efface jamais rien.

Une archive qu'on n'arrive pas à effacer (appareil hors ligne, droit manquant)
**reste marquée présente** : la rétention repassera. La marquer effacée alors
qu'elle ne l'est pas ferait grossir la destination sans que rien ne le dise —
la panne qu'on découvre quand le disque est plein.

### Notifications

Ses propres canaux, comme les autres émetteurs, par la façade du SDK
(`deps.deveyeFor(ws).notify.send(alert, { itemId })` : la route du travail
l'emporte sur celle de la fonctionnalité). **Seuls les échecs sont notifiés** :
sinon le canal se remplirait de succès et l'échec s'y perdrait.

### Une machine comme destination

L'agent écrit par la façade agents du SDK (`deps.agents.requestFilesMutate`,
`requestFilesUpload`, `awaitFilesOp`, `buffered` pour la contre-pression) :
les ordres de l'explorateur de fichiers, sans rien changer à l'agent.

---

## Sécurité

Tout vit à l'étage **ouvert** du chiffrement (voir `SECURITY_MODEL.md`), sans
exception : l'ordonnanceur passe à 3 h du matin, sans session ni mot de passe. Un
secret S3 qu'il ne pourrait pas lire serait un travail qui ne part jamais.

La clé étrangère des travaux vers leur destination cascade depuis la migration
`backup/001` du module : le refus de retirer une destination encore visée vit
dans le handler (qui dit combien de travaux bloquent), et la suppression d'un
espace ne bute plus dessus.

Le droit d'espace est `backup`, distinct de `database` exprès. Sa **lecture** est
déjà lourde : la liste des destinations dit *où sont les copies de tout*. Qui la
lit sait quel bucket viser pour obtenir la base entière sans jamais toucher à
DevEye.

En clair en base : `kind`, `device_id`, `source_kind`, le calendrier et les
drapeaux — le strict nécessaire pour que l'ordonnanceur choisisse une branche de
code et trouve les travaux dus sans déchiffrer une seule ligne. Tout le reste
(nom, chemin, endpoint, bucket, identifiant d'accès, message d'erreur, nom de
l'archive) part dans `content`.

La clé secrète S3 ne sort **jamais** : le DTO ne porte qu'un `hasSecret`.

---

## Ce qui n'est pas fait, et pourquoi

- **La restauration depuis l'interface.** DevEye montre où sont les archives et
  ce qu'elles valent ; il ne les réinjecte pas. Restaurer une base de production
  est un geste qui se fait les yeux ouverts, avec la main sur le bon serveur —
  pas derrière un bouton d'une application web qui, le jour où l'on en a besoin,
  est peut-être précisément celle qui est tombée.
- **La réplication multi-sites.** Un même travail n'écrit que vers une
  destination. Pour deux copies, on déclare deux travaux — ou l'on confie la
  redondance à Garage, dont c'est le métier (`replication_factor = 2` sur deux
  nœuds, une seule adresse pour DevEye).
- **Une source « Monitoring ».** Ces données sont dans la base de DevEye ; les
  sauvegarder à part serait les copier deux fois.
