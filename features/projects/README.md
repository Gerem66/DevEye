# Projets — gestion de projets dans DevEye

DevEye savait superviser (appareils, uptime, mail, notes, coffre) mais pas
**piloter le travail**. Ce module suit plusieurs dizaines de projets, de leurs
premières phases au déclenchement d'un déploiement.

Relu le 28 août 2026, au rapatriement de la feature en module
(`features/projects`, la quatorzième native portée sur le SDK des features,
[Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md)) et au branchement du partage inter-espaces
(§4, « Le partage »). Elle est branchée, par le SDK, sur les quatre systèmes
transverses du dépôt : [Docs/WORKSPACES.md](../../Docs/WORKSPACES.md),
[Docs/LIVE.md](../../Docs/LIVE.md), [Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md) et
[Docs/SHARING.md](../../Docs/SHARING.md).

> ⚠️ **Les objets d'espace ne sont pas ici.** Dépôts ([Git](../git/README.md)), bases
> ([Bases de données](../database/README.md)), sites suivis ([Audience](../audience/README.md))
> et cibles de déploiement ([Déploiements](../deploy/README.md)) sont des features de
> premier rang : un projet n'en garde qu'une **liaison**, et l'onglet
> correspondant n'est qu'une vue sur la feature.

> ⚠️ **Le git n'est plus ici.** Les dépôts sont devenus une feature de premier
> rang, portée par l'espace : voir [Git](../git/README.md). Un projet n'en garde
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

| En clair                                  | Pourquoi                                        |
| ----------------------------------------- | ----------------------------------------------- |
| `workspace_id`, `column_id`, `sort_order` | la frontière d'accès et l'ordre                 |
| `assignee_user_id`                        | « mes tâches, tous projets » en **une** requête |
| `due_date`, `start_date`, `archived_at`   | la frise et les retards                         |
| `message_count` + `project_card_reads`    | le badge de non-lus, sans lire un message       |
| `counts_as_done`                          | l'avancement d'un projet, calculé en SQL        |

Corollaire : **ce qui doit être unique ne peut pas être chiffré**, le chiffrement
étant non déterministe. D'où les colonnes `*_ref` — condensés stables qui portent
l'unicité pendant que la valeur lisible vit dans `content`. Le module git en fait
l'usage le plus systématique (voir [Git](../git/README.md) §2.2).

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
  serait celle du _propriétaire_ : le projet deviendrait illisible pour les
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
'open'`), le cache git étant alors suspendu au projet. Depuis [Git](../git/README.md),
> un dépôt n'a plus de tier à suivre : la garde n'a plus lieu d'être là, et la
> course qu'elle protégeait a disparu avec sa cause.

---

## 2. Ce que ça donne à l'usage

| Vue                  | Contenu                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Portefeuille**     | tous les projets, avancement, retards, prochaine échéance, non-lus                                     |
| **Mes tâches**       | mes cartes assignées, tous projets visibles d'ici confondus, projetés compris                          |
| **Archives**         | projets archivés, restaurables                                                                         |
| **Vue d'ensemble**   | avancement par colonne, échéances, mes tâches, charge de l'équipe, jalon, mises à jour, puis les liens |
| **Tableau**          | kanban, glisser-déposer (dnd-kit), colonnes, limites WIP                                               |
| **Frise**            | cartes datées, jalons, dépendances « bloque / bloqué par »                                             |
| **Git**              | les dépôts reliés — une vue sur la feature Git, voir [Git](../git/README.md)                           |
| **Bases de données** | les bases reliées — une vue sur la feature Bases, voir [Bases de données](../database/README.md)       |
| **Audience**         | les sites suivis reliés — une vue sur la feature Audience, voir [Audience](../audience/README.md)      |
| **Déploiements**     | les cibles reliées, une vue sur la feature Déploiements, voir [Déploiements](../deploy/README.md)      |
| **Uptime**           | les services surveillés rattachés, une vue sur la feature Uptime, voir [Uptime](../uptime/README.md)   |
| **Historique**       | frise verticale des faits marquants, blocs archivés en lecture seule                                   |

### La barre d'onglets suit le contenu du projet

**Un onglet obligatoire, deux au choix, cinq à la demande.** Le **Tableau** ne se
retire pas et ouvre toujours le projet : un projet sans tableau n'a plus de travail
à montrer. La **Frise** et la **Vue d'ensemble** se déclarent dans l'onglet Général
des réglages, en colonnes claires (`projects.show_timeline`, `projects.show_overview`) :
la barre se dessine avant tout déchiffrement, et un projet confidentiel verrouillé
doit pouvoir s'ouvrir sans rien réclamer. La frise vient d'office, la vue d'ensemble
se demande : elle résume, elle ne fait pas travailler, et un projet neuf n'a rien à
y montrer. L'**Historique** n'est plus un onglet de la barre mais le dernier onglet
des réglages du projet : on l'ouvre rarement, pour une question précise, et il
occupait la barre toute la journée pour ça. Les cinq autres ne
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
- **Un projet confidentiel n'a pas de « + »** : les cinq liaisons lui sont
  refusées (§1.4). Ses compteurs se lisent quand même : il peut porter des
  services surveillés rattachés avant sa conversion, et l'onglet Uptime reste
  le seul endroit d'où les atteindre.
- **Retirer le dernier élément referme l'onglet sous soi**, et renvoie au
  tableau. C'est le prix de la règle, et le geste inverse est à un clic dans le
  « + ».

### La tâche s'ouvre sur trois onglets

**Modifier, Suivi, Discussion.** Depuis le tableau, le corps de la carte ouvre le
premier, la puce des sous-tâches le deuxième, celle du fil le troisième ; sans
demande, une tâche s'ouvre sur son fil s'il a du non-lu, sur son suivi sinon. Le
fil reste monté derrière les autres onglets pour garder son abonnement, mais ne
marque rien lu tant qu'il n'est pas au premier plan.

Une **sous-tâche** porte un texte (500 caractères), un assigné, et le drapeau
« obligatoire ». Elle vit dans le corps chiffré de la carte : son assigné ne
remonte donc pas dans « Mes tâches ». Ses trois horodatages (création, coche,
auteur de la coche) sont **posés par le serveur**, qui compare la liste reçue à
la liste enregistrée : ce que le client en envoie est ignoré.

Une sous-tâche obligatoire ouverte **ferme à sa tâche l'entrée d'une colonne qui
vaut « terminé »**. `projects.cardMove` ne déchiffrant rien, le compte est tenu
en clair (`project_cards.required_open_count`), écrit par `cardAdd` et
`cardUpdate`. Seules les cartes qui entrent sont jugées : ranger la colonne reste
libre, et le serveur, qui ne voit aucun titre, rend les identifiants retenus que
le client nomme.

### Les cinq onglets d'intégration ont la même forme

Un ou plusieurs objets rattachés, **chacun dans son cadre** (y compris quand il
n'y en a qu'un : le cadre dit où finit ce que l'onglet montre), un en-tête
collant qui porte le nom et les actions, « Délier » en bout de barre et confirmé,
et le geste d'ajout **au pied de la page**.

Le Déploiement fut le dernier à s'y ranger, et il a fallu pour cela le sortir
d'ici : il vivait **dans** le projet, avec sa clé d'API rangée dans la feature
Git faute de mieux. Il est devenu une feature d'espace à son tour
([Déploiements](../deploy/README.md)), et son onglet une enveloppe mince comme les
autres.

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

**Archiver** vit dans l'onglet Général des réglages du projet
(`ProjectGeneralPanel`), sous son profil : on le fait une fois dans la vie d'un
projet, ce n'est pas un geste qui mérite d'être le plus accessible de l'écran.
Il n'y a pas de bouton « Modifier » sur la fiche : le dialogue ne fait que
créer, et c'est aussi le seul endroit où le niveau de confidentialité se
choisit (voir [Docs/SETTINGS.md](../../Docs/SETTINGS.md)). **Restaurer**, en
revanche, reste sur la carte archivée : c'est le seul geste de cet écran-là.

**Le tableau et la barre d'onglets réclament la largeur de leur contenu**
(`useRequestPopupWidth` du barrel client), entre le plancher commun de 1240 px et
la fenêtre : un kanban de trois colonnes n'a aucune raison de s'étaler jusqu'aux
bords. La demande est calculée, jamais mesurée : mesurer le `scrollWidth`
reviendrait à lire une géométrie qui dépend de la largeur qu'on est en train de
décider.

**La frise, elle, réclame tout ce que la fenêtre accorde** : sa fenêtre de temps se
déduit de la place offerte, donc chaque pixel de plus est une journée de plus sous
les yeux. Et elle se dessine sur la largeur que la popup **vise**, pas sur celle
qu'elle a (`popupTargetWidth`) : la popup s'élargit par une transition CSS de
400 ms, et une frise recalculée à chaque image de cette transition rouvre sa
fenêtre de temps quarante fois de suite — tout son contenu glisse sous les yeux
pendant que le cadre grandit. Dessinée sur la cible, elle est juste dès la première
image et le cadre ne fait que la découvrir.

Le fil de discussion vit **dans la carte** : messages en direct, groupement par
auteur, « X est en train d'écrire… », badge de non-lus sur le kanban et la frise.

### La frise se pose et se dépose à la souris

Une barre se déplace et s'étire par ses deux lisières ; sous elle, les cartes
sans date sont des pastilles, dans un repli. Le geste va dans les deux sens :
**une pastille se tire sur un jour** et y prend début et échéance le même, soit
une barre d'un jour aussitôt étirable ; **une barre se ramène sur la zone des
pastilles** et y perd ses dates. Rien n'attend la popup, et rien ne part avant
le relâchement : pendant le geste, seul un aperçu local bouge.

**Le fond, lui, fait défiler** (`Timeline/pan.ts`) : on saisit la frise et elle
suit le pointeur au pixel, comme une carte. Le geste ne part que du vide, c'est-à-dire
d'un point où aucun bouton ne réclame le pointeur (une barre, un jalon) : l'ancêtre
interactif de la cible décide, pas la cible elle-même, une barre portant un libellé
et une pile d'avatars. À la souris seulement, le doigt ayant déjà le défilement
natif de la boîte, et le curseur de préhension n'apparaît que quand il y a
effectivement de quoi défiler.

Trois détails qui ne se devinent pas, dans `Timeline/dateDrag.ts` :

- Pointer Events, jamais `draggable` : `client/src/nativeDrag.ts` refuse les
  glissers HTML5 de toute l'application, et le kanban lui-même passe par dnd-kit
  pour la même raison.
- Le jour visé par une pastille se lit en **absolu** (abscisse du pointeur dans
  la boîte défilante, `scrollLeft` compris), alors qu'une barre se déplace d'un
  **delta** en jours. Une pastille ne vient de nulle part sur l'axe : il n'y a
  rien à décaler.
- L'aperçu d'une pastille occupe une ligne ajoutée **en fin** de frise, pas son
  rang par date : les lignes sont triées sur la date, et l'insérer à sa place la
  ferait sauter d'une ligne à l'autre sous le pointeur. La même raison garde
  l'aperçu d'une barre hors de la liste triée.

La frise se dessine désormais même sans aucune carte datée, dès qu'il reste une
pastille : sans elle, le geste n'aurait nulle part où atterrir.

Le zoom règle une **durée visible** et non une densité de pixels
(`Timeline/scale.ts`) : c'est la place offerte qui en déduit la largeur d'un jour.
**L'échelle d'ouverture est un réglage du projet** (`timelineZoom`, onglet Général,
sous l'interrupteur de la frise), et vaut « Semaine » par défaut : c'est la seule
échelle où les dates se lisent au jour et où une lisière se saisit sans viser, les
autres servant à situer. Elle vit dans le corps chiffré du projet, avec le profil :
aucune requête ne la lit. La barre de la frise en change pour le temps de la
visite, sans réécrire le réglage.

### Six droits, dont cinq découpent l'écriture

`write` sur Projets laisse **participer au tableau** : retoucher une tâche et la
faire changer de colonne. Le reste se confie séparément, par les
`extraPermissions` du manifest. `history` est le seul à garder une **lecture** et
non un geste : l'histoire d'un projet ne se donne pas avec le projet. Les tâches
archivées, elles, restent ouvertes à qui voit le projet, parce que c'est de là
qu'on en restaure une et que l'archivage est la seule sortie d'une tâche. Voir [Docs/PERMISSIONS.md](../../Docs/PERMISSIONS.md) :

| Droit            | Ce qu'il ouvre                                                                     |
| ---------------- | ---------------------------------------------------------------------------------- |
| `manageProjects` | ouvrir, renommer, archiver, restaurer, classer un projet, et tenir ses colonnes    |
| `tasks`          | créer une tâche, l'archiver, la restaurer                                          |
| `plan`           | les dates sur la frise, les jalons, les dépendances                                |
| `links`          | rattacher le projet à un dépôt, une cible, une base, un site, un service surveillé |
| `chat`           | écrire et modifier dans le fil                                                     |
| `history`        | lire la frise des faits marquants d'un projet                                      |

Chacun se surcharge **projet par projet**, par l'onglet Permissions de sa fiche :
confier la planification d'un seul projet à quelqu'un est le cas courant.

`plan` a une exception, et elle est dans le handler de `projects.cardUpdate` et
non dans sa déclaration : cette commande écrit un brouillon entier, dont les
dates ne sont qu'un champ. **Chacun date la tâche qui lui revient** (celle
qu'il porte, ou celle qu'il a écrite et que personne n'a prise) sans tenir
`plan`. Une carte qu'on crée se date donc librement, et cesse de se replanifier
dès qu'elle passe à quelqu'un d'autre. Le client applique exactement le même
prédicat (`client/rights.ts`), pour que rien ne soit proposé qui serait refusé.

### La page publique

L'onglet **Page publique** de la fiche ouvre le tableau d'un projet à qui en a
le lien, sans compte, en lecture seule. Le serveur rend une page HTML complète
(`server/publicPage/`, sur le modèle des pages de statut d'Uptime) qu'un petit
script relit chaque minute ; rien du client React ne sort de l'app.

- **Ce qui sort** : l'en-tête du projet (vignette, titre, description, statut,
  version, avancement), les colonnes et les cartes (titre, priorité, début de
  la description, avancement des sous-tâches). Trois options par projet,
  fermées par défaut : les échéances et les jalons, les personnes assignées
  (leur nom, lu par `deps.membersFor`), et les sous-tâches qu'un clic déplie
  (un `<details>`, qui se déplie sans le script et reste ouvert quand il relit
  le tableau). La discussion, l'historique et les tâches archivées ne sortent
  jamais.
- **L'icône d'onglet** : la vignette du projet, servie à l'adresse de la page
  suivie de `?icone`, sous les mêmes gardes qu'elle, et revalidée à chaque
  visite. Sans vignette, le logo de DevEye (`/projet/logo.png`, tiré de
  `client/public/logo_deveye.png`).
- **L'apparence** : le sélecteur commun des pages publiques (`PageLookFields`
  du SDK, celui de Rendez-vous), automatique par défaut (le thème du
  visiteur), clair ou sombre, et un accent. Les couleurs de la page vivent dans
  `PUBLIC_BOARD_PALETTE` : la page en fait ses jetons, la vignette des réglages
  les reprend.
- **Les adresses** : un lien tiré au hasard sous l'adresse de DevEye
  (`/projet/<16 hex>`), toujours valable, et un domaine vérifié de l'espace au
  choix. Sur un domaine, le plus ancien projet en ligne en tient la racine
  (`domainRoot`), les suivants répondent sous `/projet/<chemin>`, tiré du titre
  et figé ensuite. Quand le projet de la racine s'en va, le suivant y monte.
- **Les gardes** : seul un projet ouvert se publie (le serveur n'a pas la clé
  d'un projet gardé hors session), et le passer en gardé retire sa publication,
  lien compris. Publier est un geste du domicile, sous `manageProjects`. Un
  projet déplacé perd sa publication, comme ses liaisons ; une copie arrive sans.
  Un tableau ne paraît que sous l'adresse de DevEye ou sous un domaine de son
  espace.
- **L'offre** : `projects.pages` est un stock (1 en Gratuite, 10 en Pro) qui
  compte les projets en ligne. Au-delà, l'hôte met en pause les plus
  récemment publiés, qui répondent alors « introuvable » sans que leur réglage
  ne bouge. Le domaine, lui, relève de `domains.hosts`.
- **Le coût** : un tableau se calcule au plus une fois toutes les trente
  secondes, un calcul à la fois, et la route est bornée à 300 visites par
  minute et par adresse. Une écriture sur le tableau paraît donc au public en
  une minute et demie au plus.

---

## 3. Le direct

Le module consomme le moteur existant sans le modifier, à **une exception près**.

**Ce qui est gratuit** : rafraîchissement par `mutates`, roster, contours de
présence, téléportation.

- `useLiveSegment('l1', '<id>')` sur la vue projet ;
- `useLiveSegment('l2', '<onglet>')` puis `l3` (la carte ouverte) et `l4` (son
  onglet) ;
- `useLiveOutlines('l2')` sur les cartes du kanban et les barres de la frise.

⚠️ Règle **un seul déclarant par niveau** (voir `Docs/LIVE.md`) : le niveau `l1`
appartient à `Projects.tsx`, le `l2` à `ProjectDetail.tsx`. Ne pas en poser un
second.

**Deux sujets pour une feature.** `projects` porte la structure, `projectsChat`
les messages. Sans cette coupure, chaque message ferait re-solliciter le
tableau, la frise et le portefeuille entiers. `projectsChat` est le premier
**sujet secondaire de module** : déclaré par le manifest (`topics:
[{ id: 'projectsChat', keys: ['projects.messages', 'projects.list', 'projects.board'] }]`,
le portefeuille et le tableau suivant parce que la carte porte le compte de son
fil et ce qu'il reste à y lire ; seul un écran monté relit, donc seuls ceux qui
regardent ce projet), validé au boot par
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

**L'exception : `live.typing`.** Voir `Docs/LIVE.md`, section « En train d'écrire ».

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
`DATABASE_ITEMS_PROVIDER`, `AUDIENCE_ITEMS_PROVIDER`, `DATABASE_MEASURE_PROVIDER`
(ce que Projets lit). `PROJECT_LINKED_FEATURES` y dit les cinq familles qu'un
projet relie, que la coquille de réglages lit pour son onglet « Projets ».

### Contrats : `features/projects/src/contracts/`

```
project.ts    projet, tags, tier, source de version, ligne SQL
board.ts      colonnes, cartes, priorité, sous-tâches
chat.ts       messages
plan.ts       jalons, dépendances
history.ts    événements de la frise verticale (genres `projects.*`, `card.*`, `milestone.*`, `deploy.*`)
link.ts       « mes tâches », compteurs d'onglets, lignes des cinq tables de liaison
dashboard.ts  la vue d'ensemble : agencement des tuiles, indicateurs sur mesure, ligne SQL
domain.ts     le barrel des sept
commands.ts   les commandes du module (préfixe unique `projects.`)
```

`src/manifest.ts` étale le descripteur (dont `shareTier: 'perItem'`, que le
module tient : §4, « Le partage ») et déclare ce que le registre ne porte
pas : `category: 'work'`, les liens vers les cinq features reliées, les cinq clés de
ressources (`projects.count`, `projects.list`, `projects.board`,
`projects.myTasks`, `projects.messages`), les quatre que le sujet `projects`
ravive, le sujet secondaire `projectsChat`, la capacité `members.read` (les
assignés et les mentions sont des membres), et les commandes.

### Serveur : `features/projects/src/server/`

```
index.ts            serverEntry : createRepo, features, migrationsDir, domains, quotas, createService (publie
                    PROJECTS_USAGE_PROVIDER, sert les tableaux publics), items (homeOf, labelOf, shareable : ce que
                    le partage sait des projets)
handlers.ts         l'agrégat des fichiers de commandes, ce que serverEntry.features expose
_shared.ts          Ctx, WRITE, cipherFor (création et conversion, chez lui), projectCipher (par projet, chez lui ou
                    projeté), isForeign, assertAtHome, codecs (projet, colonne, carte, événement), toProject /
                    toSummary / toMaskedSummary, loadProject (findVisible puis items.assert), assertGuardedAllowed,
                    assertProjectUnlocked, isMember, linkLabels, recordEvent, reencryptProjectTree
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
dashboard.ts        la vue d'ensemble : agencement, indicateurs (DATABASE_MEASURE_PROVIDER), garde « base reliée »
publication.ts      la page publique côté réglages : lire, publier, changer le lien ; le chemin sous un domaine
publicPage/         les routes publiques du tableau, la racine d'un domaine, la vue, le rendu HTML, le style, le script
domains.ts          les crochets des domaines : l'enregistrement CNAME, la sonde du jeton, l'usage, le retrait
env.ts              PROJECTS_SITE_URL, le lien au pied des tableaux publics
usageProvider.ts    PROJECTS_USAGE_PROVIDER : usageOf, countByItem, detach, linkTargets, link, unlink, recordEvent, applyVersion
repo/index.ts       ProjectsRepo, createRepo(SdkQueryable) : les huit dépôts natifs, un fichier par agrégat
repo/projects.ts    la table projects (listVisible, findVisible : les siens plus les projetés) et ses compteurs en clair (statsFor)
repo/board.ts       project_columns, project_cards, les non-lus
repo/chat.ts        project_messages, project_card_reads
repo/plan.ts        project_milestones, project_card_deps
repo/history.ts     project_events
repo/links.ts       les cinq tables de liaison, leurs lectures, leurs comptes et leurs usages
repo/dashboard.ts   ft_projects_dashboard_tiles : l'agencement et les indicateurs
repo/publication.ts ft_projects_public : la page publique d'un projet, la file d'un domaine, le stock de l'offre
repo/rekey.ts       la liste des cellules chiffrées suspendues à un projet (conversion d'étage)
migrations/001_event_kinds.sql   les genres d'événements stockés passent de `project.*` à `projects.*`
migrations/003_dashboard.sql     ft_projects_dashboard_tiles, première table propre au module
migrations/007_public_pages.sql  ft_projects_public
migrations/008_public_look.sql   son thème, son accent, le dépli des sous-tâches
handlers.test.ts    les handlers sur le harnais du SDK (dépôt en mémoire)
testing/            le dépôt de la page publique en mémoire, pour les tests
usageProvider.test.ts   le contrat publié, sur le harnais sessionless
publicPage/*.test.ts    les routes publiques et la vue du tableau, sur le harnais sessionless
```

Côté app, seules les migrations du socle : `060_projects_core.sql` (9 tables),
`061_projects_integrations.sql`, `064_git_repos.sql` (sort le git du projet),
`067` à `069`, `077` et `080` (les tables de liaison). Les treize tables sont
dans l'allowlist de `deveye-feature.json` : historiques, jamais déplacées,
dispensées du préfixe `ft_projects_`. Les tables de la vue d'ensemble et de la
page publique, elles, sont propres au module et le portent ; `uninstall.sql` ne
détruit qu'elles, le SQL de démontage ne pouvant pas toucher aux tables
historiques.

### Client : `features/projects/src/client/`

```
index.tsx          clientEntry : Widget, Full
Projects.tsx       portefeuille en cartes rangeables, archives, « mes tâches » ; possède le niveau live `l1`
ProjectsWidget.tsx la tuile d'accueil
api.ts             les appels typés du module (featureApi)
rights.ts          les cinq droits propres, lus sur CE projet, et les phrases de refus
ProjectDetail.tsx  en-tête + onglets ; possède le niveau live `l2`
ProjectDialog.tsx  créer un projet (le niveau de confidentialité s'y choisit)
ProjectGeneralPanel.tsx  onglet Général de la fiche : le profil du projet, et son archivage
ProjectPublicPanel.tsx   onglet Page publique de la fiche : l'ouvrir, son adresse, ses options, son apparence, changer le lien
PublicBoardPreview.tsx   la vignette du tableau public, aux couleurs que la page posera
MyTasks.tsx        mes cartes, tous projets confondus
tabs.ts            les onglets, leur ordre, et la règle qui les fait paraître
useProjectTabs.ts  les compteurs (`projects.linkCounts`) qui alimentent la barre
ProjectTabs.tsx    la barre et son menu « + »
AddFeatureDialog.tsx  les formulaires d'ajout du « + », montés hors des onglets
Board/             kanban dnd-kit, dialogues carte et colonne, largeur naturelle
Timeline/          frise horizontale, échelle dédiée, jalons, dépôt d'une carte sans date
Chat/              fil de discussion, rendu markdown
History/           frise verticale, carte archivée en lecture seule
Git/               compose le contrat client du module Git (`GIT_CLIENT_PROVIDER`), dégrade sans lui
Database/          compose le contrat client du module Bases de données (`DATABASE_CLIENT_PROVIDER`), dégrade sans lui
Audience/          compose le contrat client du module Audience (`AUDIENCE_CLIENT_PROVIDER`), dégrade sans lui
Dashboard/         la vue d'ensemble : catalogue de tuiles, compteurs de tâches, indicateurs sur mesure
Deploy/            compose le contrat client du module Déploiements (`DEPLOY_CLIENT_PROVIDER`), dégrade sans lui
Uptime/            compose le contrat client du module Uptime (`UPTIME_CLIENT_PROVIDER`), dégrade sans lui
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
- **`*_ITEMS_PROVIDER`**, lus par `ctx.providers.get(KEY)` : `exists` avant
  de poser une liaison, « cet élément existe-t-il dans cet espace ? » (le
  domicile seul), et `labelOf` pour nommer celles qui existent (le nom sous le
  codec ouvert du domicile du projet, `null` si l'élément a disparu). Module
  absent = refus propre à la pose (`validation`, « Le module X n'est pas
  installé »), jamais une ligne écrite, et des noms `null` à la lecture ;
  élément inconnu = `not_found`, sans trahir l'existence d'un élément d'un
  autre espace. Les listes d'identifiants liés se lisent, elles, sans contrat :
  les tables de liaison sont celles de Projets, et la jointure sur la table de
  la feature visée, pour l'ordre d'affichage seul, est admise.

### Le partage

Le descripteur publié dit `'perItem'`, et le module le tient
([Docs/SHARING.md](../../Docs/SHARING.md)) : un projet **ouvert** se projette vers d'autres
espaces de ses membres, un projet **gardé** jamais (`items.shareable`, que
`share.set` refuse en le disant : il est chiffré par le mot de passe de son
auteur, illisible partout ailleurs). Un projet projeté garde **un seul
domicile** : il reste chiffré sous la clé ouverte de son espace d'origine, et
la fenêtre le lit avec elle (`projectCipher` : `ctx.cipher()` chez lui,
`scope.cipherFor(id)` projeté, choisi projet par projet dans chaque listage).
Tout son arbre suit son domicile : les requêtes sont gardées par
`row.workspace_id`, jamais par l'espace actif, et les lectures par identifiant
seul (une carte, une colonne, un message, un jalon) remontent au projet, qui
est l'élément gardé (`loadProject` : `findVisible` puis `ctx.items.assert`).
Les droits sont ceux de l'espace actif, restriction par élément comprise : un
projet masqué pour ce rôle disparaît de la liste, du compte et de « mes
tâches », un projet en lecture seule ne s'écrit pas.

Trois décisions, prises avant de brancher, parce que projeter un projet posait
des questions de sens que les Notes et le Mail n'avaient pas :

- **Les membres.** Un assigné ou un auteur (carte, message, événement) n'est
  nommé que s'il est accessible depuis l'espace qu'on regarde, masqué sinon.
  Le serveur n'y touche pas : les DTO portent les identifiants tels quels, le
  client nomme parmi les membres de l'espace actif et masque un identifiant
  qu'il n'y trouve pas. Assigner ou mentionner depuis une fenêtre se fait parmi
  les membres de l'espace actif (`isMember`, la garde n'a pas changé) : on
  assigne parmi les gens qu'on voit, et l'espace d'origine masquera à son tour
  un identifiant qu'il ne connaît pas.
- **« Mes tâches » et les non-lus.** Un projet projeté **compte** dans « mes
  tâches » de la fenêtre (`projects.myTasks` liste mes cartes dans les projets
  visibles d'ici, chacun lu sous son codec), et ses non-lus sont ceux de
  l'appelant, par personne, comme aujourd'hui : le point de lecture est posé
  chez le projet, au nom de qui lit.
- **Les liaisons.** Visibles depuis la fenêtre, **par leur nom**. Les cinq
  listes (`repoList`, `deployList`, `databaseList`, `audienceList`,
  `uptimeList`) gardent leurs identifiants et rendent `labels` : une entrée par
  identifiant, toujours remplie (chez soi aussi), obtenue par le contrat
  d'éléments de la feature visée (`labelOf(id, domicile)`, sous le codec
  ouvert du domicile du projet, jamais de l'espace actif), `null` sans module
  ou quand l'élément a disparu. Relier et délier restent des gestes du
  domicile : une liaison référence un objet de l'espace d'origine, que la
  fenêtre ne voit pas.

|         | Depuis la fenêtre                                                                                                                                                                                                                                                                                                                                                                                                        | Domicile seulement                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projets | lire (portefeuille avec `foreign: true`, compteurs, non-lus) ; tout l'arbre : colonnes, cartes (ajout, édition, déplacement, archivage, assignation parmi les membres d'ici), jalons, dépendances, discussion (envoi, édition, marquage lu), historique ; le profil (`update` : titre, description, étiquettes, statut, dates), `setStatus`, une version `manual`, archiver, restaurer ; les liaisons se lisent, nommées | `setSecurityTier`, `setVersion` en `github_release` (un dépôt de là-bas), relier et délier toute liaison, le classement du portefeuille (`reorder` refuse un identifiant projeté) |

Aucune commande de suppression n'existe (§1.1) : rien à interdire de ce côté.
Le refus est `validation`, et son message dit que le geste « se règle dans son
espace d'origine » (`assertAtHome`) ; l'écran ne le propose pas.

**Passer en gardé oublie les projections.** `projects.setSecurityTier` vers
`guarded` appelle `ctx.items.forget(id)` après la conversion : plus de
projections ni de restrictions par élément. C'est juste parce qu'un projet
gardé n'existe que dans un espace personnel (`assertGuardedAllowed`), où
aucune restriction de rôle n'a de sens, et que sa clé est le mot de passe de
son auteur, qu'aucune fenêtre ne détient. La requête de projection ne rend de
toute façon que l'étage ouvert (`listVisible`, `findVisible`) : la fenêtre
perd le projet avant même le ménage, et une ligne `item_shares` dormante ne le
remontrerait pas le jour où il rouvre.

Le provider d'usage (`PROJECTS_USAGE_PROVIDER`) n'a rien à savoir des
projections : une liaison ne se pose qu'au domicile, vers un élément du même
espace, et c'est cet espace que les modules passent.

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
  tâches masquées, le partage inter-espaces (un projet projeté listé `foreign`
  sous le codec de son domicile avec ses compteurs et les non-lus de
  l'appelant, l'arbre lu et écrit depuis la fenêtre chez lui, l'assigné parmi
  les membres d'ici, mes tâches avec un projet projeté, les liaisons nommées
  par le contrat au domicile et `null` sans module, les refus depuis la
  fenêtre, `reorder` avec un identifiant projeté, le passage en gardé qui
  oublie ses projections) et l'entrée `items` (domicile, titre à l'étage
  ouvert, `shareable` faux pour un gardé) ;
- `usageProvider.test.ts` : le contrat publié (usage et comptes par élément,
  titre de secours, feature inconnue vide, frise d'un projet gardé ignorée,
  version reportée sur les seuls suiveurs ouverts, le sujet ravivé seulement
  quand quelque chose a changé) ;
- la page publique : les commandes dans `handlers.test.ts` (lien stable,
  quota compté à la mise en ligne seulement, gardé et fenêtre refusés, racine
  puis chemin sur un domaine, chemin unique, publication qui tombe avec le
  passage en gardé), les routes dans `publicPage/routes.test.ts` (introuvable
  pareil pour un lien inconnu, fermé, gardé ou en pause, domaine d'un autre
  espace refusé, options fermées par défaut, racine qui passe au suivant,
  cache) et la vue dans `publicPage/view.test.ts`.

Les parties pures du client restent vérifiables directement avec `tsx` :
l'échelle de la frise (`Timeline/scale.ts`), la largeur naturelle du kanban
(`Board/width.ts`).

**Migrations** : rejeu obligatoire sur une copie d'un dump avant livraison,
`001_event_kinds.sql` du module comprise. Elles tournent au démarrage, hors
transaction, et ne sont jamais rejouées.

### Points d'attention à l'essai manuel

1. **Droits** — un rôle sans `projects` : tuile désaturée, `handleExpand` refuse.
2. **Espaces** : un projet de l'espace A est invisible depuis B, sauf projeté
   (onglet Partage de sa fiche, ouvert seulement). Il s'y lit et s'y édite
   alors avec sa pastille, ses liaisons nommées mais non modifiables, ses
   membres inconnus d'ici masqués, et son « + » absent.
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
9. **Page publique** : ouvrir le lien en navigation privée, déplacer une carte
   et la voir paraître en moins d'une minute et demie, ouvrir puis fermer les
   deux options. Sur un domaine vérifié, un premier projet à la racine, un
   second sous `/projet/<chemin>`, et la racine qui passe au second quand le
   premier ferme.

---

## 7. Ce qui n'est pas fait

- **Aucun webhook** : l'état d'un déploiement est obtenu par sondage, borné aux
  seuls déploiements non terminés.
- **Le live est local au processus** : deux instances derrière un proxy = salles
  silencieusement séparées. Vrai avant ce module, ça le reste.
