# Déploiement — les mises en production d'un espace

> Écrit le 13 août 2026, à la fin du chantier qui a sorti le déploiement du
> module Projets ; relu et mis à jour le 21 août 2026 (sources, notifications
> par cible, coquille de réglages). Compagnon de [PROJECTS.md](./PROJECTS.md)
> et jumeau de [GIT.md](./GIT.md) : c'est le même renversement, appliqué au
> dernier module qui ne l'avait pas eu. Il dit **pourquoi** ; le code dit
> comment.

---

## 1. Le renversement

Le déploiement existait avant cette feature, mais comme une **propriété d'un
projet** : `project_deploy_targets` était clé sur `project_id`, un projet avait
donc au plus une cible, et personne d'autre ne pouvait la voir.

Trois symptômes, une seule cause :

1. **Une pile compose sert souvent deux projets.** Un client et un serveur qui
   partent ensemble, c'est le cas normal ; le second projet ne pouvait ni la
   voir ni la déclencher, il fallait la redéclarer avec sa clé.
2. **Une application qu'on veut seulement suivre**, sans projet autour, n'avait
   pas de place.
3. **La clé d'API Dokploy vivait dans la feature Git.** Elle n'y avait jamais eu
   de raison d'être : c'est l'anomalie qui a déclenché ce chantier, et elle
   n'était pas un oubli mais une conséquence — la feature Git fut la première à
   savoir gérer un secret, et le déploiement n'avait pas d'écran où loger le
   sien (voir [GIT.md](./GIT.md) §1, qui le reconnaissait déjà).

La cible est donc devenue une **entité de l'espace**. Un projet n'en garde
qu'une **liaison** — une ligne dans `project_deploy_links`, et rien d'autre.

> **Supprimer l'un ne supprime jamais l'autre.** Délier une cible d'un projet
> laisse la cible, son historique et les autres projets qui la déploient.
> Supprimer une cible laisse les projets, qui perdent seulement leur pointeur.
> L'application chez Dokploy, elle, n'est évidemment jamais touchée : DevEye ne
> fait que la pointer.

---

## 2. Les trois invariants

### 2.1 Tout est **toujours** à l'étage ouvert

Une cible appartient à l'espace, pas à un projet : elle ne peut donc suivre le
`security_tier` d'aucun d'eux. Cible et historique sont chiffrés sous la clé de
l'espace, à l'étage ouvert, une fois pour toutes.

Trois conséquences, toutes bonnes :

- la feature ne demande **jamais** de mot de passe ;
- le suivi d'état, qui tourne sans session, lit tout ce dont il a besoin ;
- la garde atomique que portait l'ancien `updateDeployment` (`JOIN projects p ON
  p.security_tier = 'open'`, contre la course « le projet passe en confidentiel
  pendant que le service de fond écrit ») **a disparu avec sa cause**, pas avec
  sa garde. Exactement ce qui était arrivé à `markSynced` en 064.

Corollaire assumé : **un projet confidentiel n'a pas de déploiement.**
`project.deployLink` le refuse, et passer un projet en confidentiel retire ses
liaisons, avec un événement de frise.

### 2.2 Le droit de déployer est un droit à part

`deploy` est un identifiant de feature distinct de `projects` et de `git`, avec
son `read` et son `write`. Ce n'est pas de la symétrie décorative : **c'est le
seul droit de DevEye qui produise un effet hors de DevEye.** `deploy: write`
autorise à poser la clé d'API d'une instance et à pousser en production ; lire
des dépôts ou piloter un tableau de tâches n'a jamais impliqué cela.

D'où le découpage des jetons : `git.credential*` pour GitHub, `deploy.credential*`
pour Dokploy, **une seule table** (`workspace_credentials`) et un comportement
partagé (`src/features/_credentials.ts`). Le dépôt exige le fournisseur sur
chaque lecture, si bien qu'aucune des deux portes ne peut servir le jeton de
l'autre, même par erreur.

### 2.3 DevEye déclenche et observe, rien de plus

Ni domaine, ni variable d'environnement, ni build : tout cela vit chez le
fournisseur, qui le fait mieux et dont ce n'est pas à nous de dupliquer
l'interface. Le module répond à deux questions : « est-ce que je peux lancer ça
d'ici ? » et « où en est le dernier ? ».

Aucun webhook n'arrive, et il n'y en aura pas : Dokploy n'émet pas de forme
générique, ses « notifications » étant mises en page pour Discord, Slack ou
Telegram. L'état est donc **sondé**, par `IntegrationSyncService.syncDeployTargets`,
qui diffuse sur les sujets `deploy` **et** `projects` — la fiche de la cible et
l'onglet du projet qui la déploie montrent le même état.

Ce sondage a changé de sujet en cours de route, et la nuance décide de ce qui est
visible. Il portait sur les **lignes encore en vol** ; il porte désormais sur les
**cibles**. Voir §6.

---

## 3. Ce que ça donne à l'usage

| Vue | Contenu |
|---|---|
| **Cibles** | toutes les cibles de l'espace, état du dernier déploiement, nombre de projets, rangeables au glisser-déposer |
| **Fiche** | l'en-tête de la cible (retour, titre, actions, dont le bouton de réglages commun), « Déployer », et l'historique de ce qui est parti |
| **Réglages → Sources** | les clés d'API Dokploy de l'espace, avec ce que chacune dessert : l'ancien bouton « Accès Dokploy », absorbé par la coquille commune (voir `SOURCES.md`) |
| **Réglages → Notifications** | les canaux de la feature (ses sources d'avis) ; chaque **cible** coche les siens dans ses propres réglages (092). Sur Discord, un message qui suit le déploiement en direct |
| **Réglages d'une cible** | notifications, partage entre espaces et permissions par rôle (`SETTINGS.md`, `SHARING.md`) |
| **Onglet d'un projet** | les cibles reliées — une vue sur cette feature, voir [PROJECTS.md](./PROJECTS.md) |

Une cible se **déclare** (elle existe déjà chez Dokploy), elle ne se crée pas :
le dialogue interroge l'instance **dès qu'on en désigne une** et propose ce
qu'elle publie, avec un repli manuel pour le jour où le décodeur ne reconnaîtra
pas une forme de réponse. L'interrogation vivait sur un bouton « Lister les
applications » : un geste que personne n'avait de raison de ne pas faire, donc
un clic imposé avant le vrai choix.

`deploy.add` est **idempotente** sur (jeton, identifiant externe) : déclarer deux
fois la même application la retrouve au lieu de la dupliquer, ce qui permet à un
projet de la déclarer sans savoir si un autre l'a déjà fait.

`deploy.trigger` accepte un `projectId` **facultatif** : déclenché depuis
l'onglet d'un projet, le fait entre dans sa frise ; déclenché depuis la feature,
il n'appartient à aucun projet en particulier, et l'attribuer à l'un d'eux au
hasard serait faux.

---

## 4. Carte du code

### Contrats — `DevEye-Types/src/`

```
domain/credential.ts   le jeton, commun aux deux features qui en possèdent
domain/deploy.ts       la cible, le déploiement, le candidat
features/deploy.ts     toutes les commandes (préfixe unique `deploy.`)
```

### Serveur — `DevEye/src/`

```
db/migrations/080_deploy_feature.sql  le renversement, données reprises
db/repos/deploy.ts                    cibles, liaisons, déploiements
db/repos/credentials.ts               les jetons, filtrés par fournisseur
features/deploy/{index,credentials,_shared}.ts
features/project/deployLink.ts        les trois commandes de liaison
features/_credentials.ts              le comportement partagé des jetons
db/migrations/085_deploy_sync_notifications.sql  le rapprochement de fond + les canaux
features/deploy/notifications.ts      où partent les avis (3 commandes)
Services/IntegrationSyncService.ts    le rapprochement de fond (minuteur propre)
Services/notifications.ts             la résolution des canaux et la livraison
Services/discord.ts                   publier ET modifier — la seule exception au canal agnostique
Services/DeployNotice.ts              la mise en forme du message vivant (barre, journal)
Services/deployNotice.test.ts         les trois calculs qui pourraient mentir sans qu'on le voie
Services/integrations/dokploy.ts      l'adaptateur tRPC
```

### Client — `DevEye/client/src/`

```
Features/Deploy/index.tsx        liste + fiche ; possède le niveau live `l1` (`target:<id>`)
Features/Deploy/TargetList.tsx   les cartes + le glisser-déposer
Features/Deploy/TargetView.tsx   ⟵ le cœur partagé avec l'onglet d'un projet
Features/Deploy/TargetDialog.tsx déclarer / régler / supprimer ; le « + » du
                                 sélecteur de jeton ouvre Réglages → Sources
Components/FeatureSettings/sections/CredentialsPanel.tsx  les jetons (panneau
                                 Sources, partagé avec Git)
Components/FeatureSettings/sections/NotificationsSection.tsx  les canaux et la
                                 sélection par cible, communs aux émetteurs
Features/Projects/Deploy/        enveloppe mince + dialogue de liaison
```

---

## 5. Pièges, et pourquoi ils existent

### La migration reprend les données, contrairement à 064

`064` avait dû faire table rase : `owner/repo` était chiffré, donc aucune requête
SQL ne pouvait dériver le condensé qui portait la nouvelle unicité. Ici rien de
tel — `external_id` est en clair, et `content` ne change pas de clé (il était
déjà à l'étage ouvert). Les cibles remontent donc telles quelles, et **deux
projets qui visaient la même application fusionnent sur une seule ligne**, ce qui
est précisément le but.

Une conséquence à connaître : un déploiement dont le projet n'avait plus de cible
(déliée entre-temps) n'a plus rien à quoi pendre et part avec l'ancienne table.
Son fait reste dans la frise du projet, qui l'a enregistré au déclenchement.

### Un nom de clé étrangère est unique **par schéma**, pas par table

`080` a échoué à son premier passage sur `CONSTRAINT fk_pdl_project` :
`project_database_links` (migration 068) le tenait déjà. InnoDB refuse, et rien
n'attrape cela avant l'exécution — deux fichiers de migration écrits à deux ans
d'écart n'ont aucune raison de se relire, et l'abréviation naturelle
(`project_deploy_links` → `pdl`) était la même. Même piège évité de justesse sur
`fk_deployment_workspace` / `fk_deployment_user`, que `project_deployments`
détient encore à l'instant où la nouvelle table est créée.

→ **Avant d'écrire un `CONSTRAINT fk_…`, le chercher dans les migrations
existantes.** Ou le lire dans la base :

```sql
SELECT constraint_name, table_name FROM information_schema.table_constraints
 WHERE constraint_schema = DATABASE() AND constraint_type = 'FOREIGN KEY';
```

### Un fichier qui peut s'arrêter au milieu doit pouvoir se rejouer

Les migrations tournent au démarrage, **hors transaction**, et `_migrations`
n'est écrit qu'après un succès complet. L'échec ci-dessus a donc laissé la base
à mi-chemin — jetons renommés, `deploy_targets` créée, le reste absent — et le
démarrage suivant rejouait le fichier **depuis le début**, pour buter cette fois
sur un `RENAME TABLE` dont la source n'existait plus.

`080` teste donc l'état avant chaque étape (`INFORMATION_SCHEMA` + SQL
dynamique, le motif de `062`). Le point le plus subtil est la reprise de
l'historique : sans clé d'unicité pour l'arrêter, un rejeu l'importerait **une
seconde fois**. Sa garde n'est pas « l'ancienne table existe » mais « la
nouvelle est vide ».

### La collation d'une table neuve vient de la base, pas du schéma

Un `CREATE TABLE` sans clause hérite du défaut de la **base**. Ce dépôt est tout
entier en `utf8mb4_general_ci`, mais une base créée sur un MySQL 8 récent vaut
`utf8mb4_0900_ai_ci`. La reprise joint une table neuve à une ancienne sur
`external_id` : deux collations de part et d'autre, et la jointure lève `Illegal
mix of collations` — au démarrage, hors transaction, à mi-migration.

Le rejeu sur copie l'a produit, parce que la base d'essai avait été créée sans
préciser son jeu de caractères. Les trois tables de `080` déclarent donc leur
collation — mais **cela ne suffisait pas**, et le rejeu suivant l'a montré : sur
une **installation neuve**, c'est l'ancienne table qui diverge, `061` la créant
sans clause à son tour. Les deux cas sont symétriques et se produisent tous les
deux pour de bon. Seule une comparaison explicite les couvre :

```sql
AND t.external_id = o.external_id COLLATE utf8mb4_general_ci
```

→ **Déclarer la collation des tables neuves, et celle des comparaisons entre
ancien et neuf.** Et rejouer sur une base au défaut différent, exprès : ce qui y
passe passera partout.

### `RENAME TABLE`, et les clés étrangères qui suivent

`project_credentials` est devenue `workspace_credentials` : elle n'a jamais rien
eu de « projet », elle s'appelait ainsi parce qu'elle est née dans ce module. Les
clés étrangères qui la visent suivent le nom automatiquement.

### Dokploy ne parle pas REST

La documentation publique décrit une API REST qui **n'existe pas** sur l'instance
de référence : tout passe par tRPC sous `/api/trpc/<procédure>`, avec des charges
utiles enveloppées par superjson. Il n'y a pas d'`application.all` (les cibles se
découvrent par `project.all`, imbriquées dans les environnements), et une infra
Dokploy est surtout faite de piles **compose**, pas d'applications — d'où
`target_kind`, sans lequel une cible est indéployable. Le détail est dans
[PROJECTS.md](./PROJECTS.md) §5, où il a été écrit.

---

## 6. Le rapprochement de fond, et les avis

> Ajouté le 18 août 2026, migration `085`.

### 6.1 Ce qui était invisible

Seules les lignes écrites par `deploy.trigger` existaient en base. Un déploiement
parti de l'interface de Dokploy, d'une CI ou d'un push git n'avait donc **aucune
ligne**, et n'apparaissait que dans `deploy.history` — une requête vers
l'instance, faite à l'ouverture d'une fiche. En arrivant sur la page, la liste ne
montrait rien de tout cela, et l'état du « dernier déploiement » d'une cible
pouvait dater de la dernière fois qu'on avait cliqué depuis DevEye.

Le sondage porte désormais sur les **cibles** : chacune est réinterrogée, et ce
que Dokploy connaît entre en base. La liste dit donc la vérité du dernier état
connu même sans réseau vers l'instance, et une cible déployée par une CI a une
frise complète sans que personne n'ait ouvert sa fiche.

### 6.2 Trois bornes, parce que c'est du sondage

| Borne | Valeur | Ce qu'elle empêche |
|---|---|---|
| `DEPLOY_TICK_SECONDS` | 10 s | — *c'est la cadence, voir 6.6* |
| `DEPLOY_BATCH` | 6 cibles / tour | quarante cibles = quarante requêtes d'un coup |
| `DEPLOY_MIN_INTERVAL_SECONDS` | 60 s **au repos** | réinterroger une cible qui n'a rien à dire |
| `DEPLOY_IMPORT_LIMIT` | 20 lignes / appel | recopier des centaines d'entrées anciennes |
| `DEPLOY_STALE_SECONDS` | 6 h | entretenir sans fin un déploiement que le fournisseur a oublié |

Une cible qui a un déploiement **en vol** échappe à la deuxième et passe à chaque
tour : c'est là que l'état bouge à la minute. Le tri est fait en SQL
(`listTargetsDue`), la sélection finale en mémoire — comme pour les dépôts git,
et pour la même raison : une poignée de cibles injoignables trie en tête (elles
n'ont jamais abouti) et consommerait chaque tour, sans quoi les autres ne
passeraient jamais. Le recul vit dans une `Map` en mémoire, jamais dans
`synced_at` (voir 6.3).

### 6.3 `synced_at` porte deux rôles, et c'est voulu

Il ordonne les cibles à réinterroger, **et** son `NULL` distingue le premier
rapprochement des suivants.

C'est cette seconde lecture qui empêche l'import initial de notifier : la
première fois, tout l'historique d'une cible est « nouveau » sans que rien ne
vienne de se produire, et l'annoncer serait un mensonge sur la date. D'où le
corollaire : **un rapprochement qui échoue ne l'horodate pas.** Sinon le suivant
prendrait tout l'historique pour du neuf et enverrait un avis par ligne.

Le premier import tait le **passé**, pas le présent : une pile en cours de
déploiement à cet instant-là entre en base non annoncée, et son avis part quand
elle atterrit — c'est un fait réel, pas du rattrapage d'historique.

`deployments.notified` complète le dispositif, sur le modèle de
`uptime_incidents.notified` : un avis appartient au **déploiement**, pas au tour
de sondage qui l'a vu. C'est ce qui fait qu'un déploiement terminé pendant que le
serveur était arrêté a bien son avis au redémarrage, et qu'il ne l'a qu'une fois.

### 6.4 Le rattachement, et ce qu'il ne peut pas faire

Une entrée du fournisseur retrouve sa ligne locale par `external_id`, sinon par
proximité de date (deux minutes) — Dokploy ne rend pas toujours d'identifiant au
déclenchement, et `deploy.trigger` écrit sa ligne **avant** d'appeler. La date
est donc réservée aux lignes qui n'ont pas encore d'identifiant, sans quoi deux
déploiements distincts partis à quelques secondes d'intervalle se colleraient sur
la même ligne. Un `Set` de lignes déjà appariées interdit qu'une même serve deux
fois dans le tour.

Reste le cas où rien ne se rattache : une ligne locale que Dokploy ne reconnaît
jamais. Au bout de six heures, ce n'est plus un déploiement en cours mais un
**suivi perdu** — elle passe à `failed` avec une description qui le dit, et
**sans avis** : on ne sait justement pas ce qui s'est passé, et annoncer un échec
qu'on n'a pas constaté serait pire que de se taire. Sans cette borne, la ligne
resterait `queued` pour toujours *et* garderait sa cible dans la voie rapide à
chaque tour.

### 6.5 Les avis ont leurs propres canaux

Le mécanisme est celui commun aux émetteurs (`Services/notifications.ts`), et
il a changé deux fois depuis l'écriture de ce document : les canaux
appartiennent à **la feature** (091, plus de liste commune aux cinq émetteurs
ni de `notification_settings`, supprimée en 087), et la sélection vit sur
**chaque cible** (092) : une cible sans canal coché ne prévient personne, il
n'y a plus d'héritage depuis la feature. Voir `NOTIFICATIONS.md`.

Un avis part à l'**atterrissage**, échec comme succès, y compris pour un
déploiement lancé ailleurs. Il n'y a pas de « retour à la normale » à annoncer,
contrairement à Uptime : un déploiement est un fait ponctuel, pas un état
continu — la mise en production suivante le dira.

### 6.6 Un minuteur à lui

Le rapprochement tournait dans le tour de la synchronisation git, à 120 s. Cela
plafonnait tout : un intervalle au repos plus court que le tour n'aurait rien
changé, et un message de suivi ne peut pas se rafraîchir moins souvent que la
boucle qui l'alimente. Les deux volets ont donc chacun leur minuteur — ils
n'avaient jamais eu la même urgence, ils partageaient un tour par accident
d'implémentation.

À 10 s et 6 cibles par tour, jusqu'à 36 cibles passent par minute, ce qui couvre
largement l'intervalle de 60 s au repos. Le coût est linéaire et modeste : dix
cibles à 60 s font un appel toutes les six secondes vers une instance
auto-hébergée.

`wake()`, appelé par `deploy.trigger`, vise ce tour-là : le message d'un
déploiement lancé depuis DevEye s'ouvre dans la foulée, sans attendre le
battement.

---

## 7. Le message qui suit le déploiement

> Ajouté le 19 août 2026. Discord uniquement — et c'est une exception assumée.

### 7.1 Un seul message, du début à la fin

Un déploiement découvert **en vol** ouvre un message Discord ; les tours suivants
le **modifient** — barre d'avancement, temps écoulé, queue du journal — jusqu'à
la conclusion, qui remplace le tout par l'issue, la durée, et l'erreur s'il y en
a une. Pas trois messages : un seul, qui évolue.

Un déploiement **trop court pour être vu en vol** reçoit exactement le même
message, publié une seule fois. Huit secondes suffisent à passer entre deux
battements, et la première version renvoyait ces cas-là vers l'avis en texte
brut : on obtenait une fiche complète pour un déploiement d'une minute et trois
lignes de texte pour celui d'à côté, sans que rien n'explique la différence.

### 7.1 bis La forme suit celle des avis de Dokploy

Trois colonnes — **projet, service, environnement** — puis type, date, durée,
puis le lien vers la fiche. C'est la structure des notifications que Dokploy
envoie lui-même, et s'en écarter obligerait à réapprendre à lire un message qu'on
reçoit dans le même salon.

Deux conséquences techniques :

- DevEye ne retient d'une cible que son identifiant externe et le nom qu'on lui a
  donné. Le projet et l'environnement viennent de `project.all` — **un seul
  appel pour toute l'instance**, mémoïsé cinq minutes : ce sont des noms
  d'organisation, qui bougent une fois par trimestre. Instance injoignable, et
  l'avis retombe sur le nom DevEye ; il perd ses colonnes, jamais son identité.
- Le lien vers la fiche a été **relevé sur l'instance, pas deviné** :
  `/dashboard/project/{id}/environment/{id}/services/{kind}/{id}` répond `307`
  (la redirection d'authentification, donc la route existe), là où les deux
  formes plus courtes répondent `404`. Un lien faux enverrait le lecteur sur une
  page d'erreur au moment précis où il cherche à comprendre un échec.

L'intitulé est réduit à la **première ligne** du message de commit : Dokploy y
range le message entier, et un commit bavard — sujet, ligne vide, quinze lignes
de justification — remplissait le haut de l'avis à chaque rafraîchissement. Le
corps est abandonné, pas déplacé : **un embed Discord n'a pas d'infobulle**, le
seul survol possible passant par un lien masqué, ce qui obligerait à transformer
l'intitulé en lien alors que celui vers Dokploy occupe déjà son propre champ. Qui
veut le message complet l'ouvre là-bas. Les points de suspension ne sont ajoutés
que si la ligne elle-même a été coupée (100 caractères) : signaler l'existence
d'un corps de commit n'apprendrait rien.

Le temps occupe **la même case** dans les deux états — « Écoulé » pendant,
« Durée » après. C'est le même message qui se transforme : l'œil ne doit pas
avoir à le rechercher au moment de la conclusion.

⚠️ **Le journal est un champ, pas un morceau de la description**, et ce n'est pas
un détail de goût : Discord rend toujours les `fields` **après** la
`description`, sans réglage possible. Tant que le journal vivait dans la seconde,
projet, service et durée se retrouvaient sous dix lignes de build. Le déplacer
est le seul moyen de les faire remonter.

Le prix est un plafond : la valeur d'un champ est limitée à 1024 caractères là où
une description en accepte 4096. `logField` retire donc des lignes **par le
haut** — les plus anciennes, les moins utiles — jusqu'à tenir, plutôt que de
laisser Discord rejeter le message entier.

Discord est le seul canal qui le permette :

- `POST /api/webhooks/{id}/{token}` **`?wait=true`** rend le message créé, donc
  son identifiant. Sans ce paramètre, la réponse est un `204` vide — c'est ce que
  fait la livraison ordinaire, qui n'en a pas l'usage.
- `PATCH /api/webhooks/{id}/{token}/messages/{id}` le modifie, **sans limite de
  durée**. Différence de fond avec les jetons d'interaction, qui expirent au bout
  d'un quart d'heure : un déploiement d'une heure se suit dans un seul message.

Aucun bot, aucun jeton d'application : l'URL de webhook déjà collée suffit.

### 7.2 Ce que ça coûte à l'invariant « on ne demande jamais quel service »

`Services/notifications.ts` est délibérément agnostique — une URL, une charge
utile à trois têtes (`content` pour Discord, `text` pour Slack, les champs
structurés pour un point d'entrée maison), et jamais la question posée à la
configuration. Le suivi vivant la pose, forcément.

Il est donc une **couche en plus**, jamais un remplacement : `Services/discord.ts`
reconnaît l'URL (analysée, pas cherchée dans la chaîne — `includes('discord.com')`
dirait oui à `https://exemple.com/?ref=discord.com`), et tout ce qui n'en est pas
garde son message unique à l'atterrissage. Rien de nouveau n'est demandé à qui a
réglé un webhook Discord, rien n'est retiré à qui en a réglé un autre.

⚠️ Corollaire à ne pas manquer : **quand le suivi vivant a conclu, le webhook est
retiré de la livraison finale**. Sans cela Discord recevrait le message modifié
*et* un second message en clair juste en dessous. Le mail, lui, est toujours
servi — il ne sait pas se modifier.

L'identifiant du message vit dans le blob chiffré de la ligne
(`StoredDeployment.noticeId`) et non dans une colonne : rien ne l'interroge, le
blob est déjà réécrit à chaque changement d'état, et une colonne aurait coûté une
migration. Il est **persisté**, ce qui est le point : un serveur redémarré au
milieu d'un déploiement reprend le message qu'il avait ouvert, au lieu d'en poser
un second à côté.

### 7.3 La barre est une estimation, et le dit

**Dokploy ne publie aucune progression.** La réponse de `deployment.all` a été
relevée sur l'instance de référence, champ par champ : `deploymentId`, `title`,
`description`, `status`, `logPath`, `pid`, `createdAt`, `startedAt`,
`finishedAt`, `errorMessage`, et des identifiants de rattachement. Rien qui
ressemble à un pourcentage ou à une étape. Le vérifier valait mieux que le
supposer : c'est ce relevé qui a décidé de la suite.

La barre est donc calculée sur la **durée moyenne des dix derniers déploiements
réussis de cette cible** — possible seulement parce que le rapprochement de fond
garde l'historique en base (§6). Trois précautions :

- **les échecs sont écartés de la moyenne.** Un échec s'arrête à la première
  étape qui casse, souvent en quelques secondes ; les mêler ferait chuter
  l'estimation à chaque build raté, et la barre d'un déploiement sain sauterait à
  100 % au bout de dix secondes ;
- **sans historique, pas de barre du tout** — seulement le temps écoulé. C'est le
  cas honnête pour une cible neuve ;
- **le dépassement est dit.** Passé la moyenne, la barre reste pleine et le texte
  annonce « plus long que d'habitude ». Un « 100 % » nu sur un déploiement qui
  continue ferait croire à une fin.

Le bornage à [0, 100] % a d'ailleurs un piège que le test a trouvé :
`Math.min`/`Math.max` **laissent passer `NaN`**, et `repeat(NaN)` rend une chaîne
vide sans lever — la barre *disparaissait* au lieu d'être bornée. D'où le
`Number.isFinite` en tête de `progressBar`.

### 7.4 Le journal, et pourquoi sa lecture est brève

⚠️ **La durée affichée est celle de Dokploy**, jamais une mesure de DevEye :
`finishedAt - startedAt`, tels que `deployment.all` les rend. Relevé sur
l'instance, `createdAt` vaut toujours `startedAt` — il n'y a donc aucun temps de
file d'attente caché qu'on pourrait ajouter, et aucun autre couple
d'horodatages dans la charge utile.

La queue du journal (8 lignes) vient du WebSocket `/listen-deployment`, déjà
utilisé par `deploy.log`.

⚠️ **`/listen-deployment` ne referme JAMAIS la connexion** — c'est un `tail -f`,
pas un téléchargement. Le code d'origine attendait la fermeture, plafonnée à
trente secondes ; mesuré sur l'instance de référence, les 22 ko d'un journal
arrivent en **un seul message, 185 ms** après l'ouverture, puis la socket reste
vivante (toujours ouverte après 40 s). La popup affichait donc « Chargement… »
une demi-minute pour un journal déjà complet, sans que rien n'échoue ni
n'apparaisse dans un journal d'erreurs.

C'est le **silence après le dernier octet** qui conclut désormais
(`LOG_IDLE_MS`, 1 s), et non l'attente d'une fermeture qui ne vient pas. Le
plafond garde son sens pour un déploiement **en cours** : celui-là émet en
continu, le silence n'arrive jamais, et c'est lui qui tranche —
`DEPLOY_LOG_TIMEOUT_MS` vaut 3 s au lieu des 30 s du régime à la demande. Les
lectures d'une même cible sont faites **en parallèle** : les enchaîner ferait
dépasser l'intervalle dès deux déploiements simultanés.

Les séquences ANSI sont retirées : Dokploy colore sa sortie de build, et un bloc
de code Discord les rendrait telles quelles.

---

## 8. Vérification

```bash
./ci.sh    # lint + typecheck des trois dépôts + build client
diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
```

**Migration** : rejeu obligatoire sur une copie d'un dump avant livraison, et
sur une copie **au défaut de collation différent** — c'est ce qui révèle les
jointures entre table neuve et table ancienne. Deux scénarios à couvrir, pas
un : la base vierge de la migration (production) **et** la base laissée à
mi-chemin par un échec (celle de développement, une fois que c'est arrivé).
Ce que la copie au défaut différent attrape à coup sûr : une table neuve avec
une clé étrangère vers `devices.id`, qu'elle déclare sa collation ou qu'elle
hérite du défaut. Sur une base restaurée d'un dump, `devices` arrive avec sa
collation d'origine épinglée, et le défaut d'accueil peut être un autre. La
seule forme juste partout lit la collation de la colonne référencée dans
`INFORMATION_SCHEMA` et construit le `CREATE TABLE` par `CONCAT` + `PREPARE`
(patron de la 098).

```bash
mysqldump ... DevEye > /tmp/dump.sql
mysql -e "CREATE DATABASE DevEye_migdry"           # défaut serveur, exprès
mysql DevEye_migdry < /tmp/dump.sql
mysql DevEye_migdry < src/db/migrations/0XX_….sql  # deux fois : ré-entrance
```

### Points d'attention à l'essai manuel

1. **Reprise** — après migration, les cibles d'avant sont là, leur historique
   aussi, et les projets qui les déployaient les voient toujours.
2. **Partage** — relier la même cible à deux projets ; sa fiche annonce le
   partage, et délier de l'un ne retire rien à l'autre.
3. **Droits** — un rôle sans `deploy` : la tuile disparaît, l'onglet d'un projet
   passe en « accès restreint », et le « + » de la barre d'onglets ne propose
   plus le déploiement. ⚠️ *Fail-closed* : les rôles existants n'ont pas ce
   droit tant qu'on ne le leur accorde pas — le propriétaire, lui, l'a d'office.
4. **Jeton retiré** — la cible reste, se peint en danger, annonce « accès
   retiré » et refuse de se déclencher.
5. **Suivi d'état** — déclencher, puis regarder « En cours » passer à « Réussi »
   sans recharger, sur la fiche **et** dans l'onglet du projet.
6. **Confidentialité** — passer un projet en confidentiel retire ses liaisons ;
   les cibles et leur historique survivent.
7. **Rapprochement** — déployer **depuis Dokploy**, sans toucher à DevEye : la
   ligne apparaît d'elle-même dans la liste et dans la fiche, au plus tard au
   quart d'heure, sans avoir ouvert quoi que ce soit.
8. **Premier import** — déclarer une cible qui a déjà de l'historique : il entre
   en base, et **aucun avis ne part**. Le déploiement *suivant*, lui, en produit
   un.
9. **Avis** — régler un webhook dans « Notifications », déployer, vérifier qu'un
   seul message arrive à l'atterrissage. Puis redémarrer le serveur au milieu
   d'un déploiement : l'avis part quand même au retour, et une seule fois.
10. **Message vivant (Discord)** — déployer et regarder **un seul** message se
    remplir : barre, journal, puis conclusion. Vérifier qu'aucun second message
    en clair ne le suit. Redémarrer le serveur en cours de déploiement : c'est le
    **même** message qui conclut, pas un nouveau.
11. **Webhook non-Discord** — même essai sur une URL Slack ou maison : un seul
    message, à la fin, comme avant. Aucune tentative de modification.
12. **Barre sans référence** — première mise en production d'une cible neuve : le
    message affiche le temps écoulé et **aucune barre**.


## Modules privés au déploiement

Le serveur tourne en tsx sur les sources : un module privé doit être PRÉSENT
dans l'arbre déployé. La recette : le dossier du module dans le contexte de
build, `features.local.json` posé à la racine de l'app (entrée
`{ "package": ..., "path": "../<module>" }`), puis `npm run gen:features`
AVANT `npm run build` du client (la glue locale est importée statiquement).
L'image publique, elle, n'exécute que `gen:features --ensure-local` : stubs
vides, aucun module privé embarqué. Les variables d'environnement et montages
propres à un module sont documentés dans son README.
