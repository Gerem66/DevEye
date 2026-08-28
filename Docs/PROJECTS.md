# Projets — gestion de projets dans DevEye

DevEye savait superviser (appareils, uptime, mail, notes, coffre) mais pas
**piloter le travail**. Ce module suit plusieurs dizaines de projets, de leurs
premières phases au déclenchement d'un déploiement.

Relu le 21 août 2026. Il est branché nativement sur les trois systèmes
transverses du dépôt : [WORKSPACES.md](./WORKSPACES.md), [LIVE.md](./LIVE.md)
et [SECURITY_MODEL.md](./SECURITY_MODEL.md).

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

L'unique exception est bornée : `project.columnRemove` détruit une colonne, mais
**refuse tant qu'elle porte la moindre carte**, archivées comprises. La
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
**toutes** les lignes rattachées au projet sont chiffrées sous cet étage — pas
de tier par carte. C'est ce qui rend la bascule atomique
(`reencryptProjectTree`) et évite d'avoir à raisonner ligne par ligne.

- `guarded` n'existe **qu'en espace personnel**. En espace partagé, cette clé
  serait celle du *propriétaire* : le projet deviendrait illisible pour les
  autres membres, ou (si l'espace a sa propre clé) lisible par tous tout en
  s'annonçant confidentiel. Les deux issues sont pires que le refus.
- Un espace partagé n'est pas pour autant en clair : son arbre est chiffré sous
  la clé de l'espace, à l'étage ouvert.

### 1.4 Un projet gardé n'a pas d'intégration externe

Ni dépôt git, ni base, ni site suivi, ni cible de déploiement. Deux raisons qui
vont dans le même sens :
le service de fond tourne **sans session** et n'atteindra jamais l'étage gardé ;
et une liaison est une ligne **en clair**, qui rattacherait un projet
confidentiel à un dépôt nommé — exactement ce que le palier est censé cacher.

`project.repoLink` refuse donc un projet gardé, et passer un projet en gardé
**retire sa liaison** (`projectSetSecurityTierFeature`), avec un événement de
frise. Le dépôt, lui, n'est pas touché : il appartient à l'espace.

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

Les compteurs viennent de `project.linkCounts`, une commande unique pour les
quatre : les demander séparément ferait quatre allers-retours pour dessiner une
barre, et la ferait apparaître par morceaux. Ils sont la **seule** source de la
barre — pas d'état d'affichage à réconcilier à côté — et se relisent sur la clé
`project.board`, celle que toute liaison invalide déjà en écrivant et que les
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
glisser-déposer par le geste partagé de `client/src/dragReorder.ts` — le même
qu'Uptime, Git, Monitoring et les bases. Le portefeuille est sa seule liste à
plusieurs colonnes, d'où son `layout: 'grid'` : les interstices y sont les
gouttières verticales, et la barre d'insertion se dresse dans la rangée visée.
`project.reorder` ne touche jamais au corps chiffré, si bien qu'un portefeuille
où dorment des projets confidentiels se range **sans rien déverrouiller**. Les
archives, elles, ne se rangent pas : elles suivent `archived_at DESC`, et
restaurer un projet le renvoie en fin de liste.

**Archiver** vit dans « Modifier le projet » : on le fait une fois dans la vie
d'un projet, ce n'est pas un geste qui mérite d'être le plus accessible de
l'écran. **Restaurer**, en revanche, reste sur la carte archivée — c'est le seul
geste de cet écran-là.

**Tableau et Frise réclament la largeur de leur contenu** (`stores/popupWidth`),
entre le plancher commun de 1240 px et la fenêtre : un kanban de trois colonnes
n'a aucune raison de s'étaler jusqu'aux bords. La demande est calculée, jamais
mesurée — mesurer le `scrollWidth` reviendrait à lire une géométrie qui dépend
de la largeur qu'on est en train de décider.

Le fil de discussion vit **dans la carte** : messages en direct, groupement par
auteur, « X est en train d'écrire… », badge de non-lus sur le kanban et la frise.

---

## 3. Le direct

Le module consomme le moteur existant sans le modifier, à **une exception près**.

**Ce qui est gratuit** : rafraîchissement par `mutates`, roster, contours de
présence, téléportation.

- `useLiveSegment('l1', 'project:<id>')` sur la vue projet ;
- `useLiveSegment('l2', 'card:<id>')` sur la carte ouverte ;
- `useLiveOutlines('l2')` sur les cartes du kanban et les barres de la frise.

⚠️ Règle **un seul déclarant par niveau** (voir `LIVE.md`) : le niveau `l1`
appartient à `Features/Projects/index.tsx`, le `l2` à `ProjectDetail.tsx`. Ne
pas en poser un second.

**Deux sujets pour une feature.** `projects` porte la structure, `projectsChat`
les messages. Sans cette coupure, chaque message ferait re-solliciter le
tableau, la frise et le portefeuille entiers. Les deux pointent la même feature
dans `TOPIC_FEATURE`, donc le même droit.

**L'exception : `live.typing`.** Voir `LIVE.md`, section « En train d'écrire ».

**La téléportation est honorée.** `Features/Projects/index.tsx` consomme la cible
`l1` que lui rend `useLiveSegment` : rejoindre quelqu'un qui regarde un projet
l'ouvre pour de bon. C'est le même chemin (`view:projects l1:project:<id>`) que
la feature Git emprunte pour son « ouvrir le projet » — un seul mécanisme pour
les deux besoins, plutôt qu'un canal de navigation dédié à côté.

---

## 4. Carte du code

### Contrats — `DevEye-Types/src/`

```
domain/project.ts        projet, tags, tier, statut, source de version
domain/projectBoard.ts   colonnes, cartes, priorité, sous-tâches
domain/projectChat.ts    messages
domain/projectPlan.ts    jalons, dépendances
domain/projectHistory.ts événements de la frise verticale
domain/projectDeploy.ts  cible et déploiements
domain/projectLink.ts    liens croisés, « mes tâches »
features/project.ts      toutes les commandes (préfixe unique `project.`)
```

Le git a son propre contrat (`domain/git.ts`, `features/git.ts`) : voir
[GIT.md](./GIT.md).

### Serveur — `DevEye/src/`

```
db/migrations/060_projects_core.sql          9 tables du socle
db/migrations/061_projects_integrations.sql  7 tables d'intégration
db/migrations/064_git_repos.sql              sort le git du projet (voir GIT.md)
db/repos/project*.ts                         un repo par agrégat
features/project/_shared.ts                  ciphers, codecs, recordEvent, rekey
features/project/{index,board,chat,timeline,history,repoLink,deployLink,links}.ts
Services/IntegrationSyncService.ts           ordonnanceur (calqué sur l'ex UptimeMonitor, devenu le service du module Uptime)
Services/integrations/{github,dokploy}.ts
```

`features/project/repoLink.ts` et `deployLink.ts` ne portent que trois commandes
chacun — poser et retirer un pointeur. Tout le reste vit dans `features/git/` et
`features/deploy/`.

### Client — `DevEye/client/src/Features/Projects/`

```
index.tsx          portefeuille en cartes rangeables, archives, « mes tâches »
ProjectDetail.tsx  en-tête + onglets ; possède le niveau live `l2`
tabs.ts            les onglets, leur ordre, et la règle qui les fait paraître
useProjectTabs.ts  les compteurs (`project.linkCounts`) qui alimentent la barre
ProjectTabs.tsx    la barre et son menu « + »
AddFeatureDialog.tsx  les formulaires d'ajout du « + », montés hors des onglets
Board/             kanban dnd-kit, dialogues carte et colonne, largeur naturelle
Timeline/          frise horizontale, échelle dédiée, jalons
Chat/              fil de discussion
Git/               enveloppe mince autour de `Features/Git/RepoView`
Database/          compose le contrat client du module Bases de données (`DATABASE_CLIENT_PROVIDER`), dégrade sans lui
Audience/          idem autour de `Features/Audience/SiteView`
Deploy/            enveloppe mince autour de `Features/Deploy/TargetView`, + services surveillés
History/           frise verticale, carte archivée en lecture seule
```

`AddFeatureDialog.tsx` monte les **mêmes** dialogues que les onglets, pas des
copies : ajouter un dépôt depuis la barre ou depuis l'onglet Git doit être le
même geste. Ils vivent au niveau du projet parce que l'onglet, lui, n'existe pas
encore — c'est ce que l'ajout va faire naître. Les deux points d'entrée ne se
marchent jamais dessus : le menu ne propose que ce qui est absent de la barre.

---

## 5. Pièges, et pourquoi ils existent

### Le filet de démarrage ne couvre pas ce module

`MUTATION_VERB` (`src/features/_topics.ts`) cherche un verbe **juste après le
point** (`notes.add`). Les commandes d'ici sont en camelCase sous un préfixe
unique (`project.cardAdd`) : **il n'en verra aucune**. Un `mutates` oublié ne
produira donc aucun avertissement au démarrage, et la donnée restera figée chez
les autres membres jusqu'au rechargement.

→ **Relire `mutates` à la main** sur chaque écriture ajoutée.

### La liste de rekey

Toute nouvelle colonne chiffrée suspendue à un projet doit être inscrite dans
`src/db/repos/projectRekey.ts` (conversion du **tier d'un projet**). Rien ne
peut le détecter : un blob chiffré est indistinguable d'un autre. Elle ne cible
une ligne que par **une seule** colonne identifiante — d'où les clés de
substitution là où la paire naturelle serait composite.

Ce qui est **toujours** sous l'étage ouvert ne relève jamais de la conversion
d'un projet : les jetons (`workspace_credentials.secret_enc`,
ex-`project_credentials`, renommée par le chantier Déploiement), et depuis la
migration `064` **tout le cache git** (`git_*`), qui appartient à l'espace et n'a
donc aucun tier de projet à suivre.

### La collision de classes CSS que rien ne signalait

`.grid` a été défini **deux fois** dans le module de style des Projets — la
grille du portefeuille, puis la couche de fond de la frise, en `position:
absolute` + `pointer-events: none`. La seconde gagnait, et la page d'accueil de
la feature devenait inutilisable. Ni TypeScript, ni ESLint, ni le build ne
disaient rien.

Deux réponses, et il fallait les deux : `client/scripts/check-css-modules.mjs`,
branché en tête du script `ci` du client, qui échoue si une classe est redéfinie
seule dans son sélecteur ; et le **découpage** du module, dont la section git est
partie dans `Features/Git/style.module.css`. Le filet attrape le symptôme, le
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
./ci.sh    # lint + typecheck des trois dépôts + build client
diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
```

Il n'existe aucun framework de test dans ce dépôt. Les parties à logique pure
sont vérifiables directement avec `tsx` — c'est ainsi qu'ont été validés
l'échelle de la frise (`Timeline/scale.ts`), la largeur naturelle du kanban
(`Board/width.ts`) et les décodeurs Dokploy (`integrations/dokploy.ts`,
tolérants aux formes de réponse inconnues).

**Migrations** : rejeu obligatoire sur une copie d'un dump avant livraison. Elles
tournent au démarrage, hors transaction, et ne sont jamais rejouées.

### Points d'attention à l'essai manuel

1. **Droits** — un rôle sans `projects` : tuile désaturée, `handleExpand` refuse.
2. **Espaces** — un projet de l'espace A est invisible depuis B.
3. **Chiffrement** — `content` illisible en base ; un projet `guarded` en espace
   personnel avec chiffrement actif déclenche l'invite, et passer un projet en
   `guarded` **retire sa liaison au dépôt** (qui, lui, survit — voir GIT.md).
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

---

## 7. Ce qui n'est pas fait

- **Aucun webhook** : l'état d'un déploiement est obtenu par sondage, borné aux
  seuls déploiements non terminés.
- **Un seul dépôt et une seule application par projet.** Au-delà, ce sont deux
  projets. Un même dépôt peut en revanche servir plusieurs projets — c'est le
  cas courant depuis [GIT.md](./GIT.md).
- **Le live est local au processus** : deux instances derrière un proxy = salles
  silencieusement séparées. Vrai avant ce module, ça le reste.
