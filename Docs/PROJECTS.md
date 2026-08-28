# Projets — gestion de projets dans DevEye

DevEye savait superviser (appareils, uptime, mail, notes, coffre) mais pas
**piloter le travail**. Ce module suit plusieurs dizaines de projets, de leurs
premières phases au déclenchement d'un déploiement.

Relu le 28 août 2026, au rapatriement de la feature en module
(`features/projects`, la quatorzième native portée sur le SDK des features,
[FEATURE_SDK.md](./FEATURE_SDK.md)). Elle est branchée, par le SDK, sur les
trois systèmes transverses du dépôt : [WORKSPACES.md](./WORKSPACES.md),
[LIVE.md](./LIVE.md) et [SECURITY_MODEL.md](./SECURITY_MODEL.md).

> ⚠️ **Les objets d'espace ne sont pas ici.** Dépôts ([GIT.md](./GIT.md)), bases
> ([DATABASES.md](./DATABASES.md)), sites suivis ([AUDIENCE.md](./AUDIENCE.md))
> et cibles de déploiement ([DEPLOY.md](./DEPLOY.md)) sont des features de
> premier rang : un projet n'en garde qu'une **liaison**, et l'onglet
> correspondant n'est qu'une vue sur la feature.

> ⚠️ **Le git n'est plus ici.** Les dépôts sont devenus une feature de premier
> rang, portée par l'espace : voir [GIT.md](./GIT.md). Un projet n'en garde
> qu'une **liaison**, et l'onglet Git n'est qu'une vue sur ce dépôt-là.

---

## 1. Les quatre invariants

Tout le reste en découle. Les rompre casse le module bien plus profondément
qu'un bug ordinaire.

### 1.1 Rien ne se supprime, tout s'archive

Il n'existe **aucune commande de suppression** de projet, de carte ou de
message. `archived_at` sort une ligne de l'espace de travail ; elle reste en
base, consultable dans l'historique, restaurable.

L'unique exception est bornée : `projects.columnRemove` détruit une colonne,
mais **refuse tant qu'elle porte la moindre carte**, archivées comprises. La
contrainte SQL est en `CASCADE` ; sans cette garde, retirer une colonne
détruirait des cartes que rien d'autre ne permet de supprimer.

### 1.2 Le chiffré ne se requête pas

Reste en **clair** ce sur quoi le serveur doit filtrer, trier, compter ou router
sans clé. Passe par `content` **chiffré** tout ce qui identifie.

| En clair | Pourquoi |
|---|---|
| `workspace_id`, `column_id`, `sort_order` | la frontière d'accès et l'ordre |
| `assignee_user_id` | « mes tâches, tous projets » en **une** requête |
| `due_date`, `start_date`, `archived_at` | la frise et les retards |
| `message_count` + `project_card_reads` | le badge de non-lus, sans lire un message |
| `counts_as_done` | l'avancement d'un projet, calculé en SQL |

Corollaire : **ce qui doit être unique ne peut pas être chiffré**, le chiffrement
étant non déterministe. D'où les colonnes `*_ref` — condensés stables qui portent
l'unicité pendant que la valeur lisible vit dans `content`. Le module git en fait
l'usage le plus systématique (voir [GIT.md](./GIT.md) §2.2).

### 1.3 Le tier est choisi par projet, et tout son arbre le suit

Sur le modèle du mail : `projects.security_tier` vaut `open` ou `guarded`, et
**toutes** les lignes rattachées au projet sont chiffrées sous cet étage : pas
de tier par carte. C'est ce qui rend la bascule atomique
(`reencryptProjectTree`) et évite d'avoir à raisonner ligne par ligne.

Dans le module, l'étage est le codec du SDK : `cipherFor(ctx, tier)` rend
`ctx.cipher()` (l'étage ouvert, l'ex `ctx.secure.open`) ou
`ctx.cipher('private')` (l'étage gardé, l'ex `ctx.secure`), et
`assertProjectUnlocked` pose la question au verrou de la session
(`ctx.secrecy.isUnlocked()`) avant toute écriture qui n'a pas besoin de lire.
Choisir le codec **est** le contrôle d'accès.

- `guarded` n'existe **qu'en espace personnel**. En espace partagé, cette clé
  serait celle du *propriétaire* : le projet deviendrait illisible pour les
  autres membres, ou (si l'espace a sa propre clé) lisible par tous tout en
  s'annonçant confidentiel. Les deux issues sont pires que le refus.
- Un espace partagé n'est pas pour autant en clair : son arbre est chiffré sous
  la clé de l'espace, à l'étage ouvert.
- Session scellée, un projet gardé **se liste masqué** (`masked: true`, ses
  compteurs restent justes : ils sont en clair), **se lit `locked`** (le client
  ouvre l'invite) et **s'écrit `locked`**, sauf ce qui ne touche aucun corps
  chiffré : réordonner le portefeuille, déplacer une carte.

### 1.4 Un projet gardé n'a pas d'intégration externe

Ni dépôt git, ni base, ni site suivi, ni cible de déploiement. Deux raisons qui
vont dans le même sens :
le service de fond tourne **sans session** et n'atteindra jamais l'étage gardé ;
et une liaison est une ligne **en clair**, qui rattacherait un projet
confidentiel à un dépôt nommé — exactement ce que le palier est censé cacher.

`projects.repoLink` refuse donc un projet gardé (et ses trois sœurs avec lui),
et passer un projet en gardé **retire ses liaisons** (`projects.setSecurityTier`),
avec un événement de frise par famille. Le dépôt, lui, n'est pas touché : il
appartient à l'espace.

> La règle vivait auparavant dans la requête `listDue` (`AND p.security_tier =
> 'open'`), le cache git étant alors suspendu au projet. Depuis [GIT.md](./GIT.md),
> un dépôt n'a plus de tier à suivre : la garde n'a plus lieu d'être là, et la
> course qu'elle protégeait a disparu avec sa cause.

---

## 2. Ce que ça donne à l'usage

| Vue | Contenu |
|---|---|
| **Portefeuille** | tous les projets, avancement, retards, prochaine échéance, non-lus |
| **Mes tâches** | mes cartes assignées, tous projets confondus |
| **Archives** | projets archivés, restaurables |
| **Tableau** | kanban, glisser-déposer (dnd-kit), colonnes, limites WIP |
| **Frise** | cartes datées, jalons, dépendances « bloque / bloqué par » |
| **Git** | les dépôts reliés — une vue sur la feature Git, voir [GIT.md](./GIT.md) |
| **Bases de données** | les bases reliées — une vue sur la feature Bases, voir [DATABASES.md](./DATABASES.md) |
| **Audience** | les sites suivis reliés — une vue sur la feature Audience, voir [AUDIENCE.md](./AUDIENCE.md) |
| **Déploiement** | les cibles reliées — une vue sur la feature Déploiement, voir [DEPLOY.md](./DEPLOY.md) — et les services surveillés |
| **Historique** | frise verticale des faits marquants, blocs archivés en lecture seule |

### La barre d'onglets suit le contenu du projet

**Trois onglets permanents, quatre à la demande.** Tableau, Frise et Historique
parlent du travail : ils existent dès le premier jour. Les quatre autres ne
montrent que des **liaisons** vers des objets d'espace — tant qu'un projet n'en
a aucune, ils n'affichaient qu'une phrase disant qu'il n'y a rien, quatre fois
de suite, et il fallait les ouvrir un par un pour s'en apercevoir.

Un onglet d'intégration paraît donc **avec son premier élément** et se replie
**avec le dernier**. Ce qui n'est pas dans la barre est dans le **« + »** posé à
son bout : le menu nomme la feature et le geste, et le clic ouvre le formulaire
d'ajout de cette feature — le même que son bouton « Ajouter un… », pas une
copie. L'ajout abouti, l'onglet naît et s'ouvre dans la foulée ; annulé, rien ne
bouge.

Les compteurs viennent de `projects.linkCounts`, une commande unique pour les
quatre : les demander séparément ferait quatre allers-retours pour dessiner une
barre, et la ferait apparaître par morceaux. Ils sont la **seule** source de la
barre (pas d'état d'affichage à réconcilier à côté) et se relisent sur la clé
`projects.board`, celle que toute liaison invalide déjà en écrivant et que les
onglets eux-mêmes écoutent. Barre et contenu ne peuvent donc pas diverger.

Trois conséquences à connaître :

- **Un compte n'est pas un droit.** Les liaisons relèvent de `projects`, leur
  contenu de la feature visée. Un membre sans accès à Git voit l'onglet Git d'un
  projet qui a des dépôts, et dedans la phrase qui explique ce qui lui manque —
  l'escamoter lui cacherait l'existence même du lien. Le « + », lui, n'offre que
  ce que l'appelant peut vraiment ajouter (voir `tabs.ts`, `add.requires`).
- **Un projet confidentiel n'a pas de « + »** : les quatre liaisons lui sont
  refusées (§1.4). Ses compteurs se lisent quand même — il peut porter des
  services surveillés rattachés avant sa conversion, et l'onglet Déploiement
  reste le seul endroit d'où les atteindre.
- **Retirer le dernier élément referme l'onglet sous soi**, et renvoie au
  tableau. C'est le prix de la règle, et le geste inverse est à un clic dans le
  « + ».

### Les quatre onglets d'intégration ont la même forme

Un ou plusieurs objets rattachés, **chacun dans son cadre** (y compris quand il
n'y en a qu'un : le cadre dit où finit ce que l'onglet montre), un en-tête
collant qui porte le nom et les actions, « Délier » en bout de barre et confirmé,
et le geste d'ajout **au pied de la page**.

Le Déploiement fut le dernier à s'y ranger, et il a fallu pour cela le sortir
d'ici : il vivait **dans** le projet, avec sa clé d'API rangée dans la feature
Git faute de mieux. Il est devenu une feature d'espace à son tour
([DEPLOY.md](./DEPLOY.md)), et son onglet une enveloppe mince comme les trois
autres. Il garde une particularité : les **services surveillés** du projet y
vivent aussi, au-dessus des cibles, parce que « est-ce en ligne ? » se lit juste
après « qu'ai-je livré ? ».

Le portefeuille est une **grille de cartes** (`auto-fill`, 320 px au minimum).
Ce furent d'abord des lignes pleine largeur, mais tout leur milieu restait vide :
le titre à gauche, l'avancement à l'autre bout, et rien entre les deux.

Une carte tient en deux rangées — identité en haut (vignette, statut, titre,
description), état en bas — et la **barre d'avancement les traverse d'un bord à
l'autre**. Elle a donc la même longueur sur toutes les cartes, ce qui est la
seule chose qu'on lui demande : que deux avancements se comparent d'un coup
d'œil. Ses deux marges sont celles du rembourrage de la carte, et rien d'autre
n'a le droit de s'intercaler à gauche — c'est pourquoi la poignée de
réorganisation est **hors du flux**, logée dans cette marge, plutôt qu'en
colonne comme dans les listes des autres features.

L'**ordre est celui de l'utilisateur** (`projects.sort_order`), rangé au
glisser-déposer par le geste de réordonnancement commun à Uptime, Git,
Monitoring et les bases (`dragReorder`). Le portefeuille est sa seule liste à
plusieurs colonnes, d'où son `layout: 'grid'` : les interstices y sont les
gouttières verticales, et la barre d'insertion se dresse dans la rangée visée.
`projects.reorder` ne touche jamais au corps chiffré, si bien qu'un portefeuille
où dorment des projets confidentiels se range **sans rien déverrouiller**. Les
archives, elles, ne se rangent pas : elles suivent `archived_at DESC`, et
restaurer un projet le renvoie en fin de liste.

**Archiver** vit dans « Modifier le projet » : on le fait une fois dans la vie
d'un projet, ce n'est pas un geste qui mérite d'être le plus accessible de
l'écran. **Restaurer**, en revanche, reste sur la carte archivée — c'est le seul
geste de cet écran-là.

**Tableau et Frise réclament la largeur de leur contenu** (`useRequestPopupWidth`
du barrel client), entre le plancher commun de 1240 px et la fenêtre : un kanban
de trois colonnes n'a aucune raison de s'étaler jusqu'aux bords. La demande est
calculée, jamais mesurée : mesurer le `scrollWidth` reviendrait à lire une
géométrie qui dépend de la largeur qu'on est en train de décider.

Le fil de discussion vit **dans la carte** : messages en direct, groupement par
auteur, « X est en train d'écrire… », badge de non-lus sur le kanban et la frise.

---

## 3. Le direct

Le module consomme le moteur existant sans le modifier, à **une exception près**.

**Ce qui est gratuit** : rafraîchissement par `mutates`, roster, contours de
présence, téléportation.

- `useLiveSegment('l1', '<id>')` sur la vue projet ;
- `useLiveSegment('l2', '<onglet>')` puis `l3` (la carte ouverte) et `l4` (son
  onglet) ;
- `useLiveOutlines('l2')` sur les cartes du kanban et les barres de la frise.

⚠️ Règle **un seul déclarant par niveau** (voir `LIVE.md`) : le niveau `l1`
appartient à `Projects.tsx`, le `l2` à `ProjectDetail.tsx`. Ne pas en poser un
second.

**Deux sujets pour une feature.** `projects` porte la structure, `projectsChat`
les messages. Sans cette coupure, chaque message ferait re-solliciter le
tableau, la frise et le portefeuille entiers. `projectsChat` est le premier
**sujet secondaire de module** : déclaré par le manifest (`topics:
[{ id: 'projectsChat', keys: ['projects.messages', 'projects.list'] }]`, le
portefeuille suivant pour ses compteurs de non-lus), validé au boot par
`buildTopicIndex` contre les manifests installés, et battu par les deux
écritures de la discussion (`mutates: ['projectsChat']` sur
`projects.messageSend` et `messageEdit`). Il relève de la feature qui le
déclare, donc du même droit ; `projects.markRead` ne bat rien, une lecture
étant personnelle. Le sujet fut longtemps inscrit en dur dans `@deveye/types`
(`nativeLiveTopicSchema`, `TOPIC_FEATURE`) : un privilège natif que le SDK a
rendu déclarable.

**Les liaisons battent deux sujets** (`mutates: ['projects', 'git']`,
`['projects', 'deploy']`, `['projects', 'database']`, `['projects', 'audience']`) :
la fiche d'un dépôt montre les projets qui l'utilisent, et doit suivre. Dans
l'autre sens, le module ravive `projects` lui-même quand un autre module écrit
chez lui par son contrat (§4) : une frise qui reçoit un déploiement, une
version qui suit une release (`deps.live.changed`).

**L'exception : `live.typing`.** Voir `LIVE.md`, section « En train d'écrire ».

**La téléportation est honorée.** `Projects.tsx` consomme la cible `l1` que lui
rend `useLiveSegment` : rejoindre quelqu'un qui regarde un projet l'ouvre pour
de bon. C'est le même chemin (`view:projects l1:<id>`) que la feature Git
emprunte pour son « ouvrir le projet » : un seul mécanisme pour les deux
besoins, plutôt qu'un canal de navigation dédié à côté.

---

## 4. Carte du code

Tout le module vit dans `features/projects/` (package `deveye-feature-projects`,
workspace npm de l'app, installé par `features.config.json` et
`npm run gen:features`). Il importe `@deveye/types`, `@deveye/types/sdk` et le
barrel client `deveye-sdk-client`, jamais l'app.

### Ce que `@deveye/types` en garde

L'identité seulement : `projects` dans les registres (feature, sujet live,
droits, accueil), le descripteur du registre (`featureDescriptor('projects')`,
étalé dans le manifest), `projectStatusSchema` (les autres modules parlent le
statut d'un projet par le contrat d'usage), et les couplages déclarés dans
`sdk/providers.ts` : `PROJECTS_USAGE_PROVIDER` (ce que Projets offre) et
`UPTIME_ITEMS_PROVIDER`, `GIT_ITEMS_PROVIDER`, `DEPLOY_ITEMS_PROVIDER`,
`DATABASE_ITEMS_PROVIDER`, `AUDIENCE_ITEMS_PROVIDER` (ce que Projets lit).

### Contrats : `features/projects/src/contracts/`

```
project.ts    projet, tags, tier, source de version, ligne SQL
board.ts      colonnes, cartes, priorité, sous-tâches
chat.ts       messages
plan.ts       jalons, dépendances
history.ts    événements de la frise verticale (genres `projects.*`, `card.*`, `milestone.*`, `deploy.*`)
link.ts       « mes tâches », compteurs d'onglets, lignes des cinq tables de liaison
domain.ts     le barrel des six
commands.ts   les cinquante et une commandes (préfixe unique `projects.`)
```

`src/manifest.ts` étale le descripteur et déclare ce que le registre ne porte
pas : `shareTier: 'never'` par-dessus le `'perItem'` publié (§4, « Le partage »),
`category: 'work'`, les liens vers les cinq features reliées, les cinq clés de
ressources (`projects.count`, `projects.list`, `projects.board`,
`projects.myTasks`, `projects.messages`), les quatre que le sujet `projects`
ravive, le sujet secondaire `projectsChat`, la capacité `members.read` (les
assignés et les mentions sont des membres), et les commandes.

### Serveur : `features/projects/src/server/`

```
index.ts            serverEntry : createRepo, features, migrationsDir, createService (publie PROJECTS_USAGE_PROVIDER)
handlers.ts         l'agrégat des dix fichiers de commandes, ce que serverEntry.features expose
_shared.ts          Ctx, WRITE, cipherFor, codecs (projet, colonne, carte, événement), toProject / toSummary /
                    toMaskedSummary, loadProject, assertGuardedAllowed, assertProjectUnlocked, isMember,
                    recordEvent, reencryptProjectTree
projects.ts         le portefeuille : list, count, get, add, update, setStatus, setVersion, setSecurityTier,
                    archive, restore, reorder
board.ts            colonnes et cartes
chat.ts             le fil d'une carte (sujet `projectsChat`)
timeline.ts         jalons et dépendances (détection de cycle)
history.ts          la frise verticale, lecture seule
links.ts            mes tâches, les compteurs d'onglets, les services surveillés (UPTIME_ITEMS_PROVIDER)
repoLink.ts         le pointeur vers les dépôts (GIT_ITEMS_PROVIDER)
deployLink.ts       le pointeur vers les cibles (DEPLOY_ITEMS_PROVIDER)
databaseLink.ts     le pointeur vers les bases (DATABASE_ITEMS_PROVIDER)
audienceLink.ts     le pointeur vers les sites (AUDIENCE_ITEMS_PROVIDER)
usageProvider.ts    PROJECTS_USAGE_PROVIDER : usageOf, countByItem, recordEvent, applyVersion
repo/index.ts       ProjectsRepo, createRepo(SdkQueryable) : les sept dépôts natifs, un fichier par agrégat
repo/projects.ts    la table projects et ses compteurs en clair (statsByWorkspace)
repo/board.ts       project_columns, project_cards, les non-lus
repo/chat.ts        project_messages, project_card_reads
repo/plan.ts        project_milestones, project_card_deps
repo/history.ts     project_events
repo/links.ts       les cinq tables de liaison, leurs lectures, leurs comptes et leurs usages
repo/rekey.ts       la liste des cellules chiffrées suspendues à un projet (conversion d'étage)
migrations/001_event_kinds.sql   les genres d'événements stockés passent de `project.*` à `projects.*`
handlers.test.ts    les handlers sur le harnais du SDK (dépôt en mémoire)
usageProvider.test.ts   le contrat publié, sur le harnais sessionless
```

Côté app, seules les migrations du socle : `060_projects_core.sql` (9 tables),
`061_projects_integrations.sql`, `064_git_repos.sql` (sort le git du projet),
`067` à `069`, `077` et `080` (les tables de liaison). Les treize tables sont
dans l'allowlist de `deveye-feature.json` : historiques, jamais déplacées,
dispensées du préfixe `ft_projects_`. Pas d'`uninstall.sql` : le module ne
possède aucune table à lui, et le SQL de démontage ne peut pas toucher aux
tables historiques (comme Mail).

### Client : `features/projects/src/client/`

```
index.tsx          clientEntry : Widget, Full
Projects.tsx       portefeuille en cartes rangeables, archives, « mes tâches » ; possède le niveau live `l1`
ProjectsWidget.tsx la tuile d'accueil
api.ts             les appels typés du module (featureApi)
ProjectDetail.tsx  en-tête + onglets ; possède le niveau live `l2`
ProjectDialog.tsx  créer et modifier un projet (archiver vit ici)
MyTasks.tsx        mes cartes, tous projets confondus
tabs.ts            les onglets, leur ordre, et la règle qui les fait paraître
useProjectTabs.ts  les compteurs (`projects.linkCounts`) qui alimentent la barre
ProjectTabs.tsx    la barre et son menu « + »
AddFeatureDialog.tsx  les formulaires d'ajout du « + », montés hors des onglets
Board/             kanban dnd-kit, dialogues carte et colonne, largeur naturelle
Timeline/          frise horizontale, échelle dédiée, jalons
Chat/              fil de discussion, rendu markdown
History/           frise verticale, carte archivée en lecture seule
Git/               compose le contrat client du module Git (`GIT_CLIENT_PROVIDER`), dégrade sans lui
Database/          compose le contrat client du module Bases de données (`DATABASE_CLIENT_PROVIDER`), dégrade sans lui
Audience/          compose le contrat client du module Audience (`AUDIENCE_CLIENT_PROVIDER`), dégrade sans lui
Deploy/            compose le contrat client du module Déploiement (`DEPLOY_CLIENT_PROVIDER`), dégrade sans lui, + services surveillés
style.module.css   le module de style, et sa déclaration typée
```

`AddFeatureDialog.tsx` monte les **mêmes** dialogues que les onglets, pas des
copies : ajouter un dépôt depuis la barre ou depuis l'onglet Git doit être le
même geste. Ils vivent au niveau du projet parce que l'onglet, lui, n'existe pas
encore : c'est ce que l'ajout va faire naître. Les deux points d'entrée ne se
marchent jamais dessus : le menu ne propose que ce qui est absent de la barre.

### Le renommage `project.*` → `projects.*`

Un module parle sous son id : le préfixe de ses commandes est `projects`, et
`commandPrefix` n'admet qu'une casse différente du même id. Les cinquante et
une commandes, les cinq clés de ressources, les genres d'événements de la
frise (`projects.created`, `projects.renamed`, `projects.version`,
`projects.status`, `projects.securityTier`, `projects.archived`,
`projects.restored`, plus les liaisons) et les actions d'audit portent donc
`projects.` là où le natif écrivait `project.`. Les noms d'export TypeScript
(`projectList`, `projectCommands`, `projectSchema`…) n'ont pas bougé. Les
événements déjà stockés sont renommés par la migration `001` du module ; sans
elle, le contrat les replierait sur son genre de repli (`projects.status`) et la
frise mentirait.

### Les contrats entre modules

Projets **publie** un contrat et en **consomme** cinq, tous par `providers`
(l'hôte les cherche à l'appel parmi les services des modules installés ; l'app
n'en offre plus aucun elle-même depuis ce rapatriement, `registerNativeProvider`
a disparu avec Projets natif).

- **`PROJECTS_USAGE_PROVIDER`**, publié par `createService` : pour un élément
  d'une autre feature, les projets ouverts de l'espace qui le relient avec leur
  titre (`usageOf`), combien en relient chacun (`countByItem`), une ligne de
  frise (`recordEvent`, un déploiement parti de l'onglet d'un projet) et la
  version que porte un élément (`applyVersion`, la dernière release d'un dépôt,
  pour les projets ouverts dont `versionSource` vaut `github_release`). Tout à
  l'étage ouvert (`deps.cipherFor`), sans session : un projet gardé ne se relie
  pas. Les deux écritures ravivent `projects` (`deps.live.changed`) quand
  elles ont changé quelque chose, ce que les services natifs de Git et de
  Déploiement faisaient en nommant `['git', 'projects']`.
- **`*_ITEMS_PROVIDER`**, lus par `ctx.providers.get(KEY)` avant de poser une
  liaison : « cet élément existe-t-il dans cet espace ? » (le domicile seul).
  Module absent = refus propre (`validation`, « Le module X n'est pas
  installé »), jamais une ligne écrite ; élément inconnu = `not_found`, sans
  trahir l'existence d'un élément d'un autre espace. Les listes d'identifiants
  liés se lisent, elles, sans contrat : les tables de liaison sont celles de
  Projets, et la jointure sur la table de la feature visée, pour l'ordre
  d'affichage seul, est admise.

### Le partage

Le descripteur publié dit `'perItem'` (un projet `open` vit à l'étage ouvert,
le serveur saurait le servir ailleurs) ; le manifest déclare `shareTier: 'never'`
par-dessus, comme les Notes et Mail, parce que le listage n'est pas branché sur
le partage ([SHARING.md](./SHARING.md) §9) et qu'un module qui déclare autre
chose s'engage à l'être (entrée `items`, `ctx.sharing.scope()`). Pas de
restriction par élément non plus : le natif n'en appliquait aucune sur les
projets, le module ne fait ni plus ni moins.

---

## 5. Pièges, et pourquoi ils existent

### Le filet de démarrage ne couvre pas ce module

`MUTATION_VERB` (`src/features/_topics.ts`) cherche un verbe **juste après le
point** (`notes.add`). Les commandes d'ici sont en camelCase sous un préfixe
unique (`projects.cardAdd`) : **il n'en verra aucune**. Un `mutates` oublié ne
produira donc aucun avertissement au démarrage, et la donnée restera figée chez
les autres membres jusqu'au rechargement.

→ **Relire `mutates` à la main** sur chaque écriture ajoutée, et tenir à jour
la liste des lectures dans `handlers.test.ts`, qui vérifie que tout le reste
déclare `mutates` sous le droit `write`.

### La liste de rekey

Toute nouvelle colonne chiffrée suspendue à un projet doit être inscrite dans
`features/projects/src/server/repo/rekey.ts` (conversion du **tier d'un
projet**). Rien ne peut le détecter : un blob chiffré est indistinguable d'un
autre. Elle ne cible une ligne que par **une seule** colonne identifiante, d'où
les clés de substitution là où la paire naturelle serait composite.

Ce qui est **toujours** sous l'étage ouvert ne relève jamais de la conversion
d'un projet : les jetons des modules (`ft_git_credentials.secret_enc`,
`ft_deploy_credentials.secret_enc`), et depuis la migration `064` **tout le
cache git** (`git_*`), qui appartient à l'espace et n'a donc aucun tier de
projet à suivre ; les cibles de déploiement de même depuis la `080`.

### La collision de classes CSS que rien ne signalait

`.grid` a été défini **deux fois** dans le module de style des Projets — la
grille du portefeuille, puis la couche de fond de la frise, en `position:
absolute` + `pointer-events: none`. La seconde gagnait, et la page d'accueil de
la feature devenait inutilisable. Ni TypeScript, ni ESLint, ni le build ne
disaient rien.

Deux réponses, et il fallait les deux : `client/scripts/check-css-modules.mjs`,
branché en tête du script `ci` du client, qui échoue si une classe est redéfinie
seule dans son sélecteur ; et le **découpage** du module, dont la section git est
partie dans `features/git/src/client/style.module.css`. Le filet attrape le symptôme, le
découpage traite la cause — un module de 2000 lignes pour une douzaine d'écrans
rend la collision structurellement probable.

### Dokploy ne parle pas REST

La documentation publique décrit une API REST (`/api/application.list`,
`/api/application.deploy`). **Elle n'existe pas** sur l'instance de référence :
tout passe par **tRPC** sous `/api/trpc/<procédure>`, avec des charges utiles
enveloppées par **superjson** (`{ result: { data: { json: … } } }` en sortie,
`{ "json": { … } }` en entrée).

Deux conséquences qui ont façonné l'adaptateur :

- **Il n'y a pas de `application.all`.** Les cibles se découvrent par
  `project.all`, imbriquées dans les environnements de chaque projet.
- **Une infra Dokploy est surtout faite de piles `compose`**, pas
  d'applications — sur l'instance de référence, 8 contre 1. Chaque type a sa
  propre procédure de déclenchement (`compose.deploy` / `application.deploy`) et
  d'historique (`deployment.allByCompose` / `deployment.all`), d'où la colonne
  `target_kind` (migration `062`) : une cible sans son type est indéployable.

Pour explorer une autre instance sans rien déclencher : un `GET` sur une
mutation tRPC répond `METHOD_NOT_SUPPORTED` (elle existe), et un `POST` avec un
corps vide renvoie le `zodError` des champs requis — la validation passe avant
l'exécution.

### `'projects'` existait déjà

La colonne `workspaces.features` de certains espaces contient l'identifiant
hérité `'projects'` (avec `servicemonitor`, `airfrance2`). Sans conséquence :
les droits d'un rôle ne sont **jamais** intersectés avec cette colonne. Ne pas
« nettoyer » ces valeurs.

---

## 6. Vérification

```bash
npm run ci            # l'app : lint, typecheck, tests, glue générée
npm run ci:features   # les modules : lint, typecheck serveur et client, tests
diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
```

Le serveur du module se teste sans base ni réseau, sur le harnais du SDK
(`@deveye/types/sdk/testing`, dépôt en mémoire) :

- `handlers.test.ts` : le registre (parité avec le contrat, `mutates` sur chaque
  écriture, `projectsChat` et les sujets doubles des liaisons), le portefeuille
  masqué ou révélé selon la session, `locked` en lecture de détail et en
  écriture sur un projet gardé scellé, les deux étages à la création (codec
  étiqueté), la conversion d'étage (tout l'arbre re-chiffré, les liaisons
  retirées avec leur frise, le suivi des releases coupé, rien touché sans
  session), le tableau et ses gardes (plafond de colonnes, colonne pleine,
  carte d'un autre projet, assigné non membre), la discussion (mentions,
  lecture d'office, pagination, mots d'autrui), la frise (cycle, jalon
  atteint, jalon d'un autre projet), l'historique paginé, les liaisons par
  contrat (absent, inconnu, gardé, idempotence), les compteurs d'onglets, mes
  tâches masquées ;
- `usageProvider.test.ts` : le contrat publié (usage et comptes par élément,
  titre de secours, feature inconnue vide, frise d'un projet gardé ignorée,
  version reportée sur les seuls suiveurs ouverts, le sujet ravivé seulement
  quand quelque chose a changé).

Les parties pures du client restent vérifiables directement avec `tsx` :
l'échelle de la frise (`Timeline/scale.ts`), la largeur naturelle du kanban
(`Board/width.ts`).

**Migrations** : rejeu obligatoire sur une copie d'un dump avant livraison,
`001_event_kinds.sql` du module comprise. Elles tournent au démarrage, hors
transaction, et ne sont jamais rejouées.

### Points d'attention à l'essai manuel

1. **Droits** — un rôle sans `projects` : tuile désaturée, `handleExpand` refuse.
2. **Espaces** — un projet de l'espace A est invisible depuis B.
3. **Chiffrement** — `content` illisible en base ; un projet `guarded` en espace
   personnel avec chiffrement actif déclenche l'invite, et passer un projet en
   `guarded` **retire ses liaisons** (les objets, eux, survivent).
4. **Direct, à deux onglets** — carte déplacée, message reçu, « X écrit… » qui
   **disparaît** quand l'onglet se ferme, contours de présence, badge non-lus.
5. **Archives** — une carte archivée quitte le tableau, apparaît dans
   l'historique, s'ouvre en lecture seule.
6. **Onglets** — un projet neuf n'ouvre que Tableau, Frise et Historique. Le
   « + » propose les quatre autres ; annuler l'ajout ne change rien, le valider
   fait paraître l'onglet **et** l'ouvre. Retirer le dernier élément d'une
   feature renvoie au tableau et remet son entrée dans le « + ». Un rôle sans
   `git`/`database`/`audience` ne voit pas l'entrée correspondante ; un projet
   confidentiel n'a pas de « + » du tout.
7. **Dialogue de tâche** — sur un projet d'une seule tâche, le bloc « Dépend
   de » ne s'affiche pas du tout ; dès qu'il y a une autre tâche, il propose de
   la choisir. La popup prend la hauteur de son contenu et grandit avec la
   discussion jusqu'au bord de l'écran, sans second ascenseur.
8. **Frise après migration** : un projet créé avant le rapatriement montre bien
   « projet créé » et non « statut modifié » en bas de son historique (la
   migration `001` a renommé les genres stockés).

---

## 7. Ce qui n'est pas fait

- **Aucun webhook** : l'état d'un déploiement est obtenu par sondage, borné aux
  seuls déploiements non terminés.
- **Les liaisons aux services surveillés ne passent pas par le contrat
  d'usage** : Uptime ne lit pas `PROJECTS_USAGE_PROVIDER`, seul l'onglet
  Déploiement d'un projet montre ses services. Le jour venu, `LINKS` dans
  `usageProvider.ts` gagne une entrée `uptime`.
- **Le partage inter-espaces** : `shareTier: 'never'` en manifest, voir §4.
- **Le live est local au processus** : deux instances derrière un proxy = salles
  silencieusement séparées. Vrai avant ce module, ça le reste.
