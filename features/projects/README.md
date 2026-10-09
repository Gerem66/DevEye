# Projets : la gestion de projets dans DevEye

Le portefeuille de projets d'un espace : pour chacun, un tableau kanban, une
frise, une discussion par tâche, un historique, une page publique, et des
liaisons vers les objets des autres features (dépôts, cibles de déploiement,
bases, sites suivis, services surveillés, dossiers). Ce document dit
_pourquoi_ ; le code dit comment.

Le module est branché, par le SDK ([Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md)),
sur les quatre systèmes transverses du dépôt : [Docs/WORKSPACES.md](../../Docs/WORKSPACES.md),
[Docs/LIVE.md](../../Docs/LIVE.md), [Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md) et
[Docs/SHARING.md](../../Docs/SHARING.md).

> ⚠️ **Les objets d'espace ne sont pas ici.** Dépôts ([Git](../git/README.md)), bases
> ([Bases de données](../database/README.md)), sites suivis ([Audience](../audience/README.md)),
> cibles de déploiement ([Déploiements](../deploy/README.md)), services
> surveillés ([Uptime](../uptime/README.md)) et dossiers de fichiers
> (Hébergement, module privé) sont des features de premier rang : un projet
> n'en garde qu'une **liaison**, et l'onglet correspondant n'est qu'une vue sur
> la feature.

---

## 1. Les quatre invariants

Tout le reste en découle. Les rompre casse le module bien plus profondément
qu'un bug ordinaire.

### 1.1 Rien ne se supprime, tout s'archive

Il n'existe **aucune commande de suppression** de projet, de carte ou de
message. `archived_at` sort une ligne de l'espace de travail ; elle reste en
base, consultable dans l'historique, restaurable.

L'unique exception est bornée : `projects.columnRemove` détruit une colonne,
mais **refuse tant qu'elle porte une carte vivante**. Les cartes archivées sont
détachées de leur colonne (`column_id` passe à `NULL`, contrainte en
`SET NULL`) et ne la retiennent pas ; restaurer une carte détachée lui redonne
la première colonne du tableau. `projects.columnPurge` archive d'un coup toutes
les cartes d'une colonne, avec une seule entrée d'historique.

### 1.2 Le chiffré ne se requête pas

Reste en **clair** ce sur quoi le serveur doit filtrer, trier, compter ou router
sans clé. Passe par `content` **chiffré** tout ce qui identifie.

| En clair                                  | Pourquoi                                         |
| ----------------------------------------- | ------------------------------------------------ |
| `workspace_id`, `column_id`, `sort_order` | la frontière d'accès et l'ordre                  |
| `assignee_user_id`                        | « mes tâches, tous projets » en **une** requête  |
| `due_date`, `start_date`, `archived_at`   | la frise et les retards                          |
| `message_count` + `project_card_reads`    | le badge de non-lus, sans lire un message        |
| `counts_as_done`                          | l'avancement d'un projet, calculé en SQL         |
| `required_open_count`                     | l'entrée d'une tâche dans une colonne terminée   |
| `show_overview`, `show_timeline`          | la barre d'onglets, dessinée avant déchiffrement |

Corollaire : **ce qui doit être unique ne peut pas être chiffré**, le chiffrement
étant non déterministe. D'où les colonnes `*_ref`, condensés stables qui portent
l'unicité pendant que la valeur lisible vit dans `content`. Le module Git en fait
l'usage le plus systématique (voir [Git](../git/README.md)).

### 1.3 Le tier est choisi par projet, et tout son arbre le suit

Sur le modèle du mail : `projects.security_tier` vaut `open` ou `guarded`, et
**toutes** les lignes rattachées au projet sont chiffrées sous cet étage : pas
de tier par carte. C'est ce qui rend la bascule atomique
(`reencryptProjectTree`) et évite d'avoir à raisonner ligne par ligne.

Dans le module, l'étage est le codec du SDK : `cipherFor(ctx, tier)` rend
`ctx.cipher()` (l'étage ouvert) ou `ctx.cipher('private')` (l'étage gardé), et
`assertProjectUnlocked` pose la question au verrou de la session
(`ctx.secrecy.isUnlocked()`) avant toute écriture qui n'a pas besoin de lire.
Choisir le codec **est** le contrôle d'accès.

- `guarded` n'existe **qu'en espace personnel** (`assertGuardedAllowed`). En
  espace partagé, cette clé serait celle du _propriétaire_ : le projet
  deviendrait illisible pour les autres membres, ou (si l'espace a sa propre
  clé) lisible par tous tout en s'annonçant confidentiel. Les deux issues sont
  pires que le refus.
- Un espace partagé n'est pas pour autant en clair : son arbre est chiffré sous
  la clé de l'espace, à l'étage ouvert.
- Session scellée, un projet gardé **se liste masqué** (`masked: true`, ses
  compteurs restent justes : ils sont en clair), **se lit `locked`** (le client
  ouvre l'invite) et **s'écrit `locked`**, sauf ce qui ne touche aucun corps
  chiffré : réordonner le portefeuille, déplacer une carte.

### 1.4 Un projet gardé n'a pas d'intégration externe

Ni dépôt git, ni base, ni site suivi, ni cible de déploiement, ni service
surveillé, ni dossier. Deux raisons qui vont dans le même sens : le service de
fond tourne **sans session** et n'atteindra jamais l'étage gardé ; et une
liaison est une ligne **en clair**, qui rattacherait un projet confidentiel à
un dépôt nommé : exactement ce que le palier est censé cacher.

`projects.repoLink` refuse donc un projet gardé (et ses cinq sœurs avec lui),
et passer un projet en gardé **retire ses liaisons** (`projects.setSecurityTier`),
avec un événement de frise par famille, ainsi que sa page publique. Le dépôt,
lui, n'est pas touché : il appartient à l'espace.

---

## 2. Ce que ça donne à l'usage

| Vue                  | Contenu                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Portefeuille**     | tous les projets, avancement, retards, prochaine échéance, non-lus                                     |
| **Mes tâches**       | mes cartes assignées, tous projets visibles d'ici confondus, projetés compris                          |
| **Archives**         | projets archivés, restaurables                                                                         |
| **Vue d'ensemble**   | avancement par colonne, échéances, mes tâches, charge de l'équipe, jalon, mises à jour, puis les liens |
| **Tableau**          | kanban, glisser-déposer (dnd-kit), colonnes (douze au plus), limites WIP, recherche                    |
| **Frise**            | cartes datées, jalons, dépendances « bloque / bloqué par »                                             |
| **Git**              | les dépôts reliés, une vue sur la feature Git, voir [Git](../git/README.md)                            |
| **Bases de données** | les bases reliées, une vue sur la feature Bases, voir [Bases de données](../database/README.md)        |
| **Audience**         | les sites suivis reliés, une vue sur la feature Audience, voir [Audience](../audience/README.md)       |
| **Déploiements**     | les cibles reliées, une vue sur la feature Déploiements, voir [Déploiements](../deploy/README.md)      |
| **Uptime**           | les services surveillés rattachés, une vue sur la feature Uptime, voir [Uptime](../uptime/README.md)   |
| **Dossiers**         | les dossiers d'Hébergement rattachés, parcourus et aperçus sur place ; absent sans le module privé     |
| **Historique**       | faits marquants et tâches archivées en une seule liste, une ligne chacun, dans les réglages du projet  |

### La barre d'onglets suit le contenu du projet

**Un onglet obligatoire, deux au choix, six à la demande** (`client/tabs.ts`).
Le **Tableau** ne se retire pas et ouvre toujours le projet (`LANDING_TAB`) :
un projet sans tableau n'a plus de travail à montrer. La **Vue d'ensemble** et
la **Frise** se déclarent dans l'onglet Général des réglages, en colonnes
claires (`projects.show_overview`, `projects.show_timeline`) : la barre se
dessine avant tout déchiffrement, et un projet confidentiel verrouillé doit
pouvoir s'ouvrir sans rien réclamer. Un projet neuf a la frise et pas la vue
d'ensemble : elle résume, elle ne fait pas travailler, et il n'y a encore rien à
y montrer. L'**Historique** est le dernier onglet des réglages du projet
(`ProjectHistoryPanel`) : on l'ouvre rarement, pour une question précise. Les
tâches archivées y sont des entrées comme les autres : à leur événement
d'archivage, ou à leur date pour celles parties avec leur colonne, rangées sous
la colonne vidée (`History/entries.ts`). Les six autres onglets ne montrent que des **liaisons** vers des objets d'espace :
tant qu'un projet n'en a aucune, ils n'afficheraient qu'une phrase disant qu'il
n'y a rien, six fois de suite.

Un onglet d'intégration paraît donc **avec son premier élément** et se replie
**avec le dernier**. Ce qui n'est pas dans la barre est dans le **« + »** posé à
son bout : le menu nomme la feature et le geste, et le clic ouvre le formulaire
d'ajout de cette feature, le même que son bouton « Ajouter un… », pas une
copie (`AddFeatureDialog.tsx`). L'ajout abouti, l'onglet naît et s'ouvre dans la
foulée ; annulé, rien ne bouge.

Les compteurs viennent de `projects.linkCounts`, une commande unique pour les
six : les demander séparément ferait six allers-retours pour dessiner une
barre, et la ferait apparaître par morceaux. Ils sont la **seule** source de la
barre (pas d'état d'affichage à réconcilier à côté, `useProjectTabs.ts`) et se
relisent sur la clé `projects.board`, celle que toute liaison invalide déjà en
écrivant et que les onglets eux-mêmes écoutent. Barre et contenu ne peuvent
donc pas diverger.

Trois conséquences à connaître :

- **Un compte n'est pas un droit.** Les liaisons relèvent de `projects`, leur
  contenu de la feature visée. Un membre sans accès à Git voit l'onglet Git d'un
  projet qui a des dépôts, et dedans la phrase qui explique ce qui lui manque :
  l'escamoter lui cacherait l'existence même du lien. Le « + », lui, n'offre que
  ce que l'appelant peut vraiment ajouter (`tabs.ts`, `add.requires` : le droit
  d'écriture sur la feature visée ; l'entrée Dossiers exige en plus que le
  contrat client d'Hébergement soit installé).
- **Un projet confidentiel n'a pas de « + »**, pas plus qu'un projet projeté
  depuis un autre espace : les six liaisons lui sont refusées (§1.4) ou
  réservées à son domicile. Ses compteurs se lisent quand même : un projet
  gardé peut porter des services surveillés rattachés avant sa conversion, et
  l'onglet Uptime reste le seul endroit d'où les atteindre.
- **Retirer le dernier élément referme l'onglet sous soi**, et renvoie au
  tableau. C'est le prix de la règle, et le geste inverse est à un clic dans le
  « + ».

### La tâche s'ouvre sur trois onglets

**Modifier, Suivi, Discussion** (`Board/CardDialog.tsx`). Depuis le tableau, le
corps de la carte ouvre le premier, la puce des sous-tâches le deuxième, celle
du fil le troisième ; sans demande, une tâche s'ouvre sur son fil s'il a du
non-lu, sur son suivi sinon. Le fil reste monté derrière les autres onglets pour
garder son abonnement, mais ne marque rien lu tant qu'il n'est pas au premier
plan.

Une **sous-tâche** porte un texte (500 caractères,
`PROJECT_CHECKLIST_LABEL_MAX_LENGTH`), un assigné, et le drapeau
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

### La recherche du tableau

Le champ de l'en-tête, à côté du choix du jalon, garde les tâches dont chaque
mot se retrouve dans le titre, la description, une sous-tâche, ou le nom de qui
porte la tâche ou l'une de ses sous-tâches, sans casse ni accents
(`Board/search.ts`). Elle se fait dans le client : ces champs sont chiffrés. Un
membre hors de l'espace actif n'y est pas nommé, il ne se trouve donc pas.

Les autres tâches **quittent la vue mais pas l'ordre** : une tâche trouvée se
glisse comme d'habitude, et le dépôt renvoie la colonne entière, les masquées à
leur place et la tâche posée juste après sa voisine visible du dessus. Le
compteur d'une colonne et sa limite comptent toujours toutes ses tâches. Le
jalon, lui, estompe sans retirer ; les deux se combinent.

### Les six onglets d'intégration ont la même forme

Un ou plusieurs objets rattachés, **chacun dans son cadre** (y compris quand il
n'y en a qu'un : le cadre dit où finit ce que l'onglet montre), un en-tête
collant qui porte le nom et les actions, « Délier » en bout de barre et confirmé,
et le geste d'ajout **au pied de la page**. Chaque onglet compose le contrat
client de la feature visée (`GIT_CLIENT_PROVIDER`, `DEPLOY_CLIENT_PROVIDER`,
`DATABASE_CLIENT_PROVIDER`, `AUDIENCE_CLIENT_PROVIDER`, `UPTIME_CLIENT_PROVIDER`,
`HOSTING_CLIENT_PROVIDER`) et se dégrade sans lui. Déploiements est une feature
d'espace ([Déploiements](../deploy/README.md)) ; son onglet est une enveloppe
mince comme les autres.

### Le portefeuille

Le portefeuille est une **grille de cartes** (`auto-fill`, 320 px au minimum).
Une carte tient en deux rangées, identité en haut (vignette, statut, titre,
description) et état en bas, et la **barre d'avancement les traverse d'un bord à
l'autre**. Elle a donc la même longueur sur toutes les cartes, ce qui est la
seule chose qu'on lui demande : que deux avancements se comparent d'un coup
d'œil. Ses deux marges sont celles du rembourrage de la carte, et rien d'autre
n'a le droit de s'intercaler à gauche : c'est pourquoi la poignée de
réorganisation est **hors du flux**, logée dans cette marge, plutôt qu'en
colonne comme dans les listes des autres features.

L'**ordre est celui de l'utilisateur** (`projects.sort_order`), rangé au
glisser-déposer par le geste de réordonnancement du barrel client
(`useDragReorder`). Le portefeuille est sa seule liste à plusieurs colonnes,
d'où son `layout: 'grid'` : les interstices y sont les gouttières verticales,
et la barre d'insertion se dresse dans la rangée visée. `projects.reorder` ne
touche jamais au corps chiffré, si bien qu'un portefeuille où dorment des
projets confidentiels se range **sans rien déverrouiller**. Les archives,
elles, ne se rangent pas : elles suivent `archived_at DESC`, et restaurer un
projet le renvoie en fin de liste.

**Archiver** vit dans l'onglet Général des réglages du projet
(`ProjectGeneralPanel`), sous son profil : on le fait une fois dans la vie d'un
projet, ce n'est pas un geste qui mérite d'être le plus accessible de l'écran.
Il n'y a pas de bouton « Modifier » sur la fiche : le dialogue ne fait que
créer, et c'est aussi le seul endroit où le niveau de confidentialité se
choisit (voir [Docs/SETTINGS.md](../../Docs/SETTINGS.md)). **Restaurer**, en
revanche, reste sur la carte archivée : c'est le seul geste de cet écran-là.

### La largeur de la popup

**Le tableau et la barre d'onglets réclament la largeur de leur contenu**
(`useRequestPopupWidth` du barrel client), entre la largeur de confort commune
à toutes les vues (`BASE_MAX_WIDTH`, 1240 px) et la fenêtre : un kanban de
trois colonnes n'a aucune raison de s'étaler jusqu'aux bords. La demande est
calculée (`Board/width.ts`), jamais mesurée sur la largeur obtenue : mesurer le
`scrollWidth` reviendrait à lire une géométrie qui dépend de la largeur qu'on
est en train de décider.

**La frise, elle, réclame tout ce que son zoom accepte d'afficher**
(`timelineNaturalWidth`) : sa fenêtre de temps se déduit de la place offerte,
donc chaque pixel de plus est une journée de plus sous les yeux, sans dépasser
ce que le niveau promet. Et elle se dessine sur la largeur que la popup
**vise**, pas sur celle qu'elle a (`popupTargetWidth`) : la popup s'élargit par
une transition CSS de 400 ms, et une frise recalculée à chaque image de cette
transition rouvrirait sa fenêtre de temps à chaque image : tout son contenu
glisserait sous les yeux pendant que le cadre grandit. Dessinée sur la cible,
elle est juste dès la première image et le cadre ne fait que la découvrir.

Le fil de discussion vit **dans la carte** : messages en direct, groupement par
auteur, « X est en train d'écrire… », badge de non-lus sur le kanban et la frise.

### La frise se pose et se dépose à la souris

Une barre se déplace et s'étire par ses deux lisières ; sous elle, les cartes
sans date sont des pastilles, dans un repli. Le geste va dans les deux sens :
**une pastille se tire sur un jour** et y prend début et échéance le même, soit
une barre d'un jour aussitôt étirable ; **une barre se ramène sur la zone des
pastilles** et y perd ses dates. Le « + » de la barre d'outils se dépose de
même, pour une tâche ou un jalon qui n'existent pas encore. Rien ne part avant
le relâchement : pendant le geste, seul un aperçu local bouge.

**Le fond, lui, fait défiler** (`Timeline/pan.ts`) : on saisit la frise et elle
suit le pointeur au pixel, comme une carte. Le geste ne part que du vide, c'est-à-dire
d'un point où aucun bouton ne réclame le pointeur (une barre, un jalon) : l'ancêtre
interactif de la cible décide, pas la cible elle-même, une barre portant un libellé
et une pile d'avatars. À la souris seulement, le doigt ayant déjà le défilement
natif de la boîte, et le curseur de préhension n'apparaît que quand il y a
effectivement de quoi défiler.

Deux détails qui ne se devinent pas, dans `Timeline/dateDrag.ts` :

- Pointer Events, jamais `draggable` : `client/src/nativeDrag.ts` refuse les
  glissers HTML5 de toute l'application, et le kanban lui-même passe par dnd-kit
  pour la même raison.
- Le jour visé par une pastille se lit en **absolu** (abscisse du pointeur dans
  la boîte défilante, `scrollLeft` compris), alors qu'une barre se déplace d'un
  **delta** en jours. Une pastille ne vient de nulle part sur l'axe : il n'y a
  rien à décaler.

La frise se dessine dès qu'il reste une pastille à y déposer, même sans aucune
carte datée ni jalon : sans elle, le geste n'aurait nulle part où atterrir.

Le zoom règle une **durée visible** et non une densité de pixels
(`Timeline/scale.ts` : Année, Trimestre, Mois, Semaine) : c'est la place
offerte qui en déduit la largeur d'un jour. **L'échelle d'ouverture est un
réglage du projet** (`timelineZoom`, onglet Général, sous l'interrupteur de la
frise), et vaut « Semaine » par défaut : c'est la seule échelle où les dates se
lisent au jour et où une lisière se saisit sans viser, les autres servant à
situer. Elle vit dans le corps chiffré du projet, avec le profil : aucune
requête ne la lit. La barre de la frise en change pour le temps de la visite,
sans réécrire le réglage.

### Six droits, dont cinq découpent l'écriture

`write` sur Projets laisse **participer au tableau** : retoucher une tâche et la
faire changer de colonne. Le reste se confie séparément, par les
`extraPermissions` du manifest. `history` est le seul à garder une **lecture** et
non un geste : l'histoire d'un projet ne se donne pas avec le projet. Les tâches
archivées, elles, restent ouvertes à qui voit le projet, parce que c'est de là
qu'on en restaure une et que l'archivage est la seule sortie d'une tâche : sans
`history`, la liste ne montre qu'elles. Voir
[Docs/PERMISSIONS.md](../../Docs/PERMISSIONS.md) :

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
prédicat (`client/rights.ts`), pour que rien ne soit proposé qui serait refusé ;
ce qui est refusé se grise avec sa raison plutôt que de disparaître.

### La page publique

L'onglet **Page publique** de la fiche (`ProjectPublicPanel`) ouvre le tableau
d'un projet à qui en a le lien, sans compte, en lecture seule. Le serveur rend
une page HTML complète (`server/publicPage/`, sur le modèle des pages de statut
d'Uptime) qu'un petit script relit chaque minute ; rien du client React ne sort
de l'app. La page est tenue hors des moteurs de recherche, et sa politique de
contenu la laisse s'intégrer dans le site de son propriétaire
(`frame-ancestors *`).

- **Ce qui sort** : l'en-tête du projet (vignette, titre, description, statut,
  version, avancement), les colonnes et les cartes (titre, priorité, début de
  la description, avancement des sous-tâches). Trois options par projet,
  fermées par défaut : les échéances et les jalons (`show_dates`), les
  personnes assignées (`show_assignees`, leur nom lu par `deps.membersFor`), et
  les sous-tâches qu'un clic déplie (`show_subtasks`, un `<details>` qui se
  déplie sans le script et reste ouvert quand il relit le tableau). La
  discussion, l'historique et les tâches archivées ne sortent jamais.
- **L'icône d'onglet** : la vignette du projet, servie à l'adresse de la page
  suivie de `?icone`, sous les mêmes gardes qu'elle, et revalidée à chaque
  visite. Sans vignette, l'icône de DevEye que l'hôte sert à tous
  (`DEVEYE_ICON_PATH`).
- **L'apparence** : le sélecteur commun des pages publiques (`PageLookFields`
  du barrel client), automatique par défaut (le thème du visiteur), clair ou
  sombre, et un accent. Les couleurs de la page vivent dans
  `PUBLIC_BOARD_PALETTE` (`contracts/publication.ts`) : la page en fait ses
  jetons, la vignette des réglages (`PublicBoardPreview`) les reprend.
- **Les adresses** : un lien tiré au hasard sous l'adresse de DevEye
  (`/projet/<16 hex>`, `PUBLIC_PATH`), toujours valable et remplaçable
  (`projects.publicationRelink`), et un domaine vérifié de l'espace au choix.
  Sur un domaine, le plus ancien projet en ligne en tient la racine
  (`domainRoot`), les suivants répondent sous `/projet/<chemin>`, tiré du
  titre et figé ensuite. Quand le projet de la racine s'en va, le suivant y
  monte. Le module prouve qu'un domaine est le sien par le jeton que sa route
  publique rend sous `/.well-known/deveye-projects` (`server/domains.ts`).
- **Les gardes** : seul un projet ouvert se publie (le serveur n'a pas la clé
  d'un projet gardé hors session), et le passer en gardé retire sa publication,
  lien compris. Publier est un geste du domicile, sous `manageProjects`. Un
  projet déplacé perd sa publication, comme ses liaisons ; une copie arrive sans.
  Un tableau ne paraît que sous l'adresse de DevEye ou sous un domaine de son
  espace.
- **L'offre** : `projects.pages` est un stock qui compte les projets en ligne.
  Au-delà de la limite, l'hôte met en pause les plus récemment publiés, qui
  répondent alors « introuvable » sans que leur réglage ne bouge (§6).
- **Le coût** : un tableau se calcule au plus une fois toutes les trente
  secondes, un calcul à la fois, et la route est bornée à 300 visites par
  minute et par adresse ; le script est servi avec un ETag. Une écriture sur le
  tableau paraît donc au public en une minute et demie au plus.

---

## 3. Le direct

Le module consomme le moteur existant sans le modifier, à **une exception près**.

**Ce qui est gratuit** : rafraîchissement par `mutates`, roster, contours de
présence, téléportation.

- `useLiveSegment('l1', '<id>')` sur la vue projet, et `useLiveOutlines('l1')`
  sur les cartes du portefeuille ;
- `useLiveSegment('l2', 'tab:<onglet>')` puis `l3` (la carte ouverte) et `l4`
  (son onglet) ;
- `useLiveOutlines('l2')` sur les onglets, `useLiveOutlines('l3')` sur les
  cartes du kanban et les barres de la frise, `useLiveOutlines('l4')` sur les
  onglets de la tâche.

⚠️ Règle **un seul déclarant par niveau** ([Docs/LIVE.md](../../Docs/LIVE.md)) :
le niveau `l1` appartient à `Projects.tsx`, les `l2` et `l3` à
`ProjectDetail.tsx`, le `l4` à `Board/CardDialog.tsx`. Ne pas en poser un
second.

**Deux sujets pour une feature.** `projects` porte la structure, `projectsChat`
les messages. Sans cette coupure, chaque message ferait re-solliciter le
tableau, la frise et le portefeuille entiers. `projectsChat` est un **sujet
secondaire de module** (Docs/LIVE.md, « Les sujets secondaires d'un module »),
déclaré par le manifest (`topics:
[{ id: 'projectsChat', keys: ['projects.messages', 'projects.list', 'projects.board'] }]`,
le portefeuille et le tableau suivant parce que la carte porte le compte de son
fil et ce qu'il reste à y lire ; seul un écran monté relit, donc seuls ceux qui
regardent ce projet), validé au boot par `buildTopicIndex` contre les manifests
installés, et battu par les deux écritures de la discussion
(`mutates: ['projectsChat']` sur `projects.messageSend` et `messageEdit`). Il
relève de la feature qui le déclare, donc du même droit ; `projects.markRead` ne
bat rien, une lecture étant personnelle.

**Les liaisons battent deux sujets** (`mutates: ['projects', 'git']`,
`['projects', 'deploy']`, `['projects', 'database']`, `['projects', 'audience']`,
`['projects', 'uptime']`) : la fiche d'un dépôt montre les projets qui
l'utilisent, et doit suivre. Sauf Hébergement : module privé, son sujet n'existe
pas sur une instance qui ne l'a pas, et le démarrage y refuserait
`['projects', 'x-hosting']`. Ses liaisons ne battent que `projects`. Dans
l'autre sens, le module ravive `projects` lui-même quand un autre module écrit
chez lui par son contrat (§4) : une frise qui reçoit un déploiement, une
version qui suit une release (`deps.live.changed`). Le sujet `domain` ravive
`projects.publication` : un domaine vérifié, en pause ou retiré change
l'adresse qu'une page publique donne à partager.

**L'exception : `live.typing`.** Voir Docs/LIVE.md, section « En train d'écrire ».

**La téléportation est honorée.** `Projects.tsx` consomme la cible `l1` que lui
rend `useLiveSegment` : rejoindre quelqu'un qui regarde un projet l'ouvre pour
de bon. C'est le même chemin (`view:projects l1:<id>`) que les features Git,
Bases de données et Audience empruntent pour leur « ouvrir le projet »
(`openFeature('projects', id)`) : un seul mécanisme pour les deux besoins,
plutôt qu'un canal de navigation dédié à côté.

---

## 4. Carte du code

Tout le module vit dans `features/projects/` (package `deveye-feature-projects`,
workspace npm de l'app, installé par `features.config.json` et
`npm run gen:features`). Il importe `@deveye/types`, `@deveye/types/sdk` et le
barrel client `deveye-sdk-client`, jamais l'app, à une exception commentée près :
`server/domains.ts` importe le garde SSRF `safeFetch` de `Services/netFetch`,
parce que le nom qu'il sonde est choisi par un membre.

### Ce que `@deveye/types` en garde

L'identité seulement : `projects` dans les registres (feature, sujet live,
droits, accueil), le descripteur du registre (`featureDescriptor('projects')`,
étalé dans le manifest), `projectStatusSchema` (les autres modules parlent le
statut d'un projet par le contrat d'usage), et les couplages déclarés dans
`sdk/providers.ts` : `PROJECTS_USAGE_PROVIDER` (ce que Projets offre) et
`UPTIME_ITEMS_PROVIDER`, `GIT_ITEMS_PROVIDER`, `DEPLOY_ITEMS_PROVIDER`,
`DATABASE_ITEMS_PROVIDER`, `AUDIENCE_ITEMS_PROVIDER`, `HOSTING_ITEMS_PROVIDER`,
`DATABASE_MEASURE_PROVIDER` (ce que Projets lit). `PROJECT_LINKED_FEATURES` y
dit les six familles qu'un projet relie, que la coquille de réglages lit pour
son onglet « Projets ».

### Contrats : `features/projects/src/contracts/`

```
project.ts      projet, tags, tier, source de version, zoom de la frise, ligne SQL
board.ts        colonnes (douze au plus), cartes, priorité, sous-tâches (500 caractères)
chat.ts         messages
plan.ts         jalons, dépendances
history.ts      événements de la frise verticale (genres `projects.*`, `card.*`, `milestone.*`, `deploy.*`)
link.ts         « mes tâches », compteurs d'onglets, lignes des six tables de liaison
dashboard.ts    la vue d'ensemble : agencement des tuiles, indicateurs sur mesure, ligne SQL
publication.ts  la page publique : `PUBLIC_PATH`, le chemin sous un domaine, les thèmes, `PUBLIC_BOARD_PALETTE`, ligne SQL
domain.ts       le barrel des huit
commands.ts     les commandes du module (préfixe unique `projects.`)
```

`src/manifest.ts` étale le descripteur (dont `shareTier: 'perItem'`, que le
module tient : §4, « Le partage ») et déclare ce que le registre ne porte
pas : `category: 'work'`, les liens vers les six features reliées, les six
clés de ressources (`projects.count`, `projects.list`, `projects.board`,
`projects.myTasks`, `projects.messages`, `projects.publication`), les cinq que
le sujet `projects` ravive (toutes sauf les messages), le sujet secondaire
`projectsChat`, le sujet `domain` pour la publication, les capacités
`members.read` (les assignés et les mentions sont des membres) et
`routes.public` (le tableau public), le stock `pages`, le bloc `domains`
(`web: true`), les six droits propres, les onglets de réglages d'un projet
(Général, Page publique, Historique) et ceux de la feature (Domaines), et les
commandes.

### Serveur : `features/projects/src/server/`

```
index.ts            serverEntry : createRepo, features, migrationsDir, domains, quotas (le stock `pages`), createService
                    (publie PROJECTS_USAGE_PROVIDER, sert les tableaux publics et la racine d'un domaine), items (homeOf,
                    labelOf, shareable, move, copy), accountExport
handlers.ts         l'agrégat des fichiers de commandes, ce que serverEntry.features expose
_shared.ts          Ctx, les niveaux d'accès (WRITE, MANAGE, TASKS, PLAN, LINKS, CHAT, HISTORY), cipherFor (création et
                    conversion, chez lui), projectCipher (par projet, chez lui ou projeté), isForeign, assertAtHome, codecs
                    (projet, colonne, carte, jalon, événement), toProject / toSummary / toMaskedSummary, loadProject
                    (findVisible puis items.assert), assertGuardedAllowed, assertProjectUnlocked, isMember, linkLabels,
                    recordEvent, reencryptProjectTree
projects.ts         le portefeuille : list, count, get, add, update, setStatus, setVersion, setSecurityTier, archive, restore,
                    reorder
board.ts            colonnes (ajout, mise à jour, retrait, purge, ordre) et cartes (ajout, mise à jour, déplacement,
                    archivage, restauration, jalon)
chat.ts             le fil d'une carte (sujet `projectsChat`) et le point de lecture
timeline.ts         jalons et dépendances (détection de cycle)
history.ts          la frise verticale, lecture seule
links.ts            mes tâches, les compteurs d'onglets, les services surveillés (UPTIME_ITEMS_PROVIDER)
repoLink.ts         le pointeur vers les dépôts (GIT_ITEMS_PROVIDER)
deployLink.ts       le pointeur vers les cibles (DEPLOY_ITEMS_PROVIDER)
databaseLink.ts     le pointeur vers les bases (DATABASE_ITEMS_PROVIDER)
audienceLink.ts     le pointeur vers les sites (AUDIENCE_ITEMS_PROVIDER)
hostingLink.ts      le pointeur vers les dossiers d'Hébergement (HOSTING_ITEMS_PROVIDER)
dashboard.ts        la vue d'ensemble : agencement, indicateurs (DATABASE_MEASURE_PROVIDER), garde « base reliée »
publication.ts      la page publique côté réglages : lire, publier, changer le lien ; le chemin sous un domaine
publicPage/         routes.ts (les routes publiques du tableau, la racine d'un domaine, le cache, l'icône), view.ts (ce que
                    le visiteur voit, options appliquées), render.ts (le HTML), style.ts (la feuille), script.ts (la relecture
                    chaque minute), html.ts
domains.ts          les crochets des domaines : l'enregistrement à publier, la sonde du jeton, l'usage, le retrait
usageProvider.ts    PROJECTS_USAGE_PROVIDER : usageOf, countByItem, detach, linkTargets, link, unlink, recordEvent, applyVersion,
                    authorize, linkedItems
copy.ts             l'arbre d'un projet (`projectsTree`) et ce qu'une copie abandonne
move.ts             le changement d'espace : rescelle l'arbre, retire liaisons et page publique, détache les bases des indicateurs
accountExport.ts    ce que l'export du compte écrit de chaque table (les points de lecture exceptés)
repo/index.ts       ProjectsRepo, createRepo(SdkQueryable) : les neuf dépôts, un fichier par agrégat
repo/projects.ts    la table projects (listVisible, findVisible : les siens plus les projetés) et ses compteurs en clair (statsFor)
repo/board.ts       project_columns, project_cards, les non-lus
repo/chat.ts        project_messages, project_card_reads
repo/plan.ts        project_milestones, project_card_deps
repo/history.ts     project_events
repo/links.ts       les six tables de liaison, leurs lectures, leurs comptes et leurs usages
repo/dashboard.ts   ft_projects_dashboard_tiles : l'agencement et les indicateurs
repo/publication.ts ft_projects_public : la page publique d'un projet, la file d'un domaine, le stock de l'offre
repo/rekey.ts       la liste des cellules chiffrées suspendues à un projet (conversion d'étage)
uninstall.sql       les trois tables propres au module
testing/            le dépôt de la page publique en mémoire, pour les tests
handlers.test.ts, usageProvider.test.ts, accountExport.test.ts, publicPage/routes.test.ts, publicPage/view.test.ts
```

Les migrations du module (`src/server/migrations/`) :

```
001_event_kinds.sql          les genres d'événements stockés prennent le préfixe `projects.`
002_archived_card_detach.sql `project_cards.column_id` nullable, contrainte en SET NULL
003_dashboard.sql            ft_projects_dashboard_tiles
004_card_required_open.sql   `project_cards.required_open_count`
005_project_show_overview.sql `projects.show_overview`
006_project_tabs.sql         `projects.show_timeline`, et la vue d'ensemble effacée par défaut
007_public_pages.sql         ft_projects_public
008_public_look.sql          son thème, son accent, le dépli des sous-tâches
009_drop_landing_tab.sql     retrait d'une colonne que rien ne lit
010_hosting_links.sql        ft_projects_hosting_links, sans clé étrangère vers un module privé
```

Côté app, les migrations du socle qui ont créé les treize tables historiques :
`060_projects_core.sql`, `061_projects_integrations.sql`,
`062_project_deploy_kind.sql`, `064_git_repos.sql`,
`067_project_uptime_links.sql`, `068_databases.sql`,
`069_project_multi_repo.sql`, `077_project_audience_links.sql`,
`080_deploy_feature.sql`. Ces treize tables sont dans l'allowlist de
`deveye-feature.json` : jamais déplacées, dispensées du préfixe `ft_projects_`.
Les tables de la vue d'ensemble, de la page publique et de la liaison aux
dossiers, elles, sont propres au module et le portent ; `uninstall.sql` ne
détruit qu'elles, le SQL de démontage ne pouvant pas toucher aux tables
historiques.

### Client : `features/projects/src/client/`

```
index.tsx          clientEntry : Widget, Full, les trois panneaux de réglages, cacheDurationMinutes: 0, holdSecrecy
Projects.tsx       portefeuille en cartes rangeables, archives, « mes tâches » ; possède le niveau live `l1`
ProjectsWidget.tsx la tuile d'accueil
api.ts             les appels typés du module (featureApi), les libellés et l'ordre des statuts
rights.ts          les cinq droits propres, lus sur CE projet, et les phrases de refus
ProjectDetail.tsx  en-tête + onglets ; possède les niveaux live `l2` et `l3`
ProjectDialog.tsx  créer un projet (le niveau de confidentialité s'y choisit)
ProjectGeneralPanel.tsx  onglet Général de la fiche : le profil du projet, ses onglets déclarés, le zoom de la frise, son archivage
ProjectPublicPanel.tsx   onglet Page publique de la fiche : l'ouvrir, son adresse, ses options, son apparence, changer le lien
ProjectHistoryPanel.tsx  onglet Historique de la fiche : une seule liste, faits marquants (droit `history`) et tâches archivées
PublicBoardPreview.tsx   la vignette du tableau public, aux couleurs que la page posera
MyTasks.tsx        mes cartes, tous projets confondus
tabs.ts            les onglets, leur ordre, et la règle qui les fait paraître
useProjectTabs.ts  les compteurs (`projects.linkCounts`) qui alimentent la barre, et ce que le « + » propose
ProjectTabs.tsx    la barre et son menu « + »
AddFeatureDialog.tsx  les formulaires d'ajout du « + », montés hors des onglets
ForeignLinks.tsx   les liaisons d'un projet projeté, nommées et en lecture seule
Member.tsx         un assigné ou un auteur, nommé s'il est membre de l'espace actif, masqué sinon
Milestone.tsx      la pastille et la teinte d'un jalon, par jetons du thème
Board/             kanban dnd-kit (Board.tsx), sa recherche (search.ts), dialogues carte et colonne, sous-tâches,
                   largeur naturelle (width.ts)
Timeline/          frise horizontale (Timeline.tsx), échelle (scale.ts), glissé de dates (dateDrag.ts), défilement (pan.ts),
                   dialogue de jalon
Chat/              fil de discussion, rendu markdown
History/           la liste (History.tsx), sa fusion avec les tâches archivées (entries.ts), tâche archivée en lecture seule
Dashboard/         la vue d'ensemble : catalogue de tuiles, compteurs de tâches, indicateurs sur mesure
Git/               compose le contrat client du module Git (`GIT_CLIENT_PROVIDER`), dégrade sans lui
Database/          compose le contrat client du module Bases de données (`DATABASE_CLIENT_PROVIDER`), dégrade sans lui
Audience/          compose le contrat client du module Audience (`AUDIENCE_CLIENT_PROVIDER`), dégrade sans lui
Deploy/            compose le contrat client du module Déploiements (`DEPLOY_CLIENT_PROVIDER`), dégrade sans lui
Uptime/            compose le contrat client du module Uptime (`UPTIME_CLIENT_PROVIDER`), dégrade sans lui
Hosting/           compose le contrat client d'Hébergement (`HOSTING_CLIENT_PROVIDER`) ; son « + » n'est offert qu'installé
style.module.css   le module de style, et sa déclaration typée
```

`AddFeatureDialog.tsx` monte les **mêmes** dialogues que les onglets, pas des
copies : ajouter un dépôt depuis la barre ou depuis l'onglet Git doit être le
même geste. Ils vivent au niveau du projet parce que l'onglet, lui, n'existe pas
encore : c'est ce que l'ajout va faire naître. Les deux points d'entrée ne se
marchent jamais dessus : le menu ne propose que ce qui est absent de la barre.

### Les noms

Un module parle sous son id : commandes, clés de ressources, genres
d'événements et actions d'audit portent le préfixe `projects.`. La migration
`001` du module renomme les genres d'événements stockés sous `project.*` ; sans
elle, le contrat les replierait sur son genre de repli (`projects.status`) et
la frise mentirait. Les noms d'export TypeScript (`projectList`,
`projectCommands`, `projectSchema`…) ne suivent pas cette règle.

### Les contrats entre modules

Projets **publie** un contrat et en **consomme** six, tous par `providers`
(l'hôte les cherche à l'appel parmi les services des modules installés).

- **`PROJECTS_USAGE_PROVIDER`**, publié par `createService` : pour un élément
  d'une autre feature, les projets ouverts de l'espace qui le relient avec leur
  titre (`usageOf`), combien en relient chacun (`countByItem`), les projets
  qu'on peut lui relier et le geste dans les deux sens (`linkTargets`, `link`,
  `unlink`), le retrait de ses liaisons quand il disparaît (`detach`), une
  ligne de frise (`recordEvent`, un déploiement parti de l'onglet d'un projet)
  et la version que porte un élément (`applyVersion`, la dernière release d'un
  dépôt, pour les projets ouverts dont `versionSource` vaut `github_release`).
  Pour Uptime, qui désigne un projet comme source de déploiement : le droit de
  lecture d'un membre sur un projet (`authorize`, un projet gardé masqué) et
  les cibles et dépôts qu'il relie (`linkedItems`).
  Tout à l'étage ouvert (`deps.cipherFor`), sans session : un projet gardé ne
  se relie pas. Les écritures ravivent `projects` (`deps.live.changed`) quand
  elles ont changé quelque chose.
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
- **`DATABASE_MEASURE_PROVIDER`** : les indicateurs sur mesure de la vue
  d'ensemble mesurent une base reliée au projet, par le contrat du module Bases
  de données.

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

Trois décisions, parce que projeter un projet pose des questions de sens que
les Notes et le Mail n'ont pas :

- **Les membres.** Un assigné ou un auteur (carte, message, événement) n'est
  nommé que s'il est accessible depuis l'espace qu'on regarde, masqué sinon
  (`Member.tsx`). Le serveur n'y touche pas : les DTO portent les identifiants
  tels quels, le client nomme parmi les membres de l'espace actif et masque un
  identifiant qu'il n'y trouve pas. Assigner ou mentionner depuis une fenêtre
  se fait parmi les membres de l'espace actif (`isMember`) : on assigne parmi
  les gens qu'on voit, et l'espace d'origine masquera à son tour un identifiant
  qu'il ne connaît pas.
- **« Mes tâches » et les non-lus.** Un projet projeté **compte** dans « mes
  tâches » de la fenêtre (`projects.myTasks` liste mes cartes dans les projets
  visibles d'ici, chacun lu sous son codec), et ses non-lus sont ceux de
  l'appelant, par personne : le point de lecture est posé chez le projet, au
  nom de qui lit.
- **Les liaisons.** Visibles depuis la fenêtre, **par leur nom**
  (`ForeignLinks.tsx`). Les six listes (`repoList`, `deployList`,
  `databaseList`, `audienceList`, `uptimeList`, `hostingList`) gardent leurs
  identifiants et rendent `labels` : une entrée par identifiant, toujours
  remplie (chez soi aussi), obtenue par le contrat d'éléments de la feature
  visée (`labelOf(id, domicile)`, sous le codec ouvert du domicile du projet,
  jamais de l'espace actif), `null` sans module ou quand l'élément a disparu.
  Relier et délier restent des gestes du domicile : une liaison référence un
  objet de l'espace d'origine, que la fenêtre ne voit pas.

|         | Depuis la fenêtre                                                                                                                                                                                                                                                                                                                                                                                                        | Domicile seulement                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projets | lire (portefeuille avec `foreign: true`, compteurs, non-lus) ; tout l'arbre : colonnes, cartes (ajout, édition, déplacement, archivage, assignation parmi les membres d'ici), jalons, dépendances, discussion (envoi, édition, marquage lu), historique ; le profil (`update` : titre, description, étiquettes, statut, dates), `setStatus`, une version `manual`, archiver, restaurer ; les liaisons se lisent, nommées | `setSecurityTier`, `setVersion` en `github_release` (un dépôt de là-bas), relier et délier toute liaison, publier et régler la page publique, le classement du portefeuille (`reorder` refuse un identifiant projeté) |

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

### Déplacer, copier, exporter

Les deux gestes de la coquille ([Docs/SHARING.md](../../Docs/SHARING.md) §9 et §10)
s'appuient sur le même arbre, `projectsTree` dans `copy.ts` : le projet, ses
colonnes, ses jalons, ses cartes, leurs dépendances, ses messages, les tuiles
de sa vue d'ensemble et sa frise d'activité, avec pour chaque table les
cellules scellées. Toute nouvelle colonne chiffrée suspendue à un projet doit y
entrer, comme dans `repo/rekey.ts` : rien ne peut détecter un blob oublié.

- **Déplacer** (`move.ts`) rescelle l'arbre sous l'étage ouvert du nouvel
  espace, fait suivre les points de lecture, et range le projet en fin de
  portefeuille. Ce que le projet reliait reste dans l'espace quitté : les six
  familles de liaison partent, la page publique aussi (elle tient à l'offre et
  aux domaines de l'espace quitté), et un indicateur sur mesure perd sa base
  mais garde sa requête. Un projet gardé est refusé en amont par `shareable`.
- **Copier** emporte l'arbre sous la clé de la destination, sans les auteurs,
  assignations et mentions (un compte d'ici n'existe pas forcément là-bas),
  sans la frise d'activité (elle reste l'histoire de l'original), sans les
  bases des indicateurs ni les liaisons.
- **Exporter** (`accountExport.ts`, [Docs/ACCOUNT_EXPORT.md](../../Docs/ACCOUNT_EXPORT.md))
  écrit chaque table du module en JSON, corps déchiffrés, sauf les points de
  lecture des discussions, qui ne servent qu'à l'affichage des non-lus.

---

## 5. Pièges, et pourquoi ils existent

### Le filet de démarrage ne couvre pas ce module

`MUTATION_VERB` (`src/features/_topics.ts`) reconnaît une écriture à un verbe
placé **juste après le point** (`notes.add`). Les commandes d'ici sont en
camelCase sous un nom composé (`projects.cardAdd`, `projects.messageSend`) :
il ne les voit pas. Un `mutates` oublié sur l'une d'elles ne produira donc
aucun avertissement au démarrage, et la donnée restera figée chez les autres
membres jusqu'au rechargement.

→ **Relire `mutates` à la main** sur chaque écriture ajoutée, et tenir à jour
la liste des lectures dans `handlers.test.ts`, qui vérifie que tout le reste
déclare `mutates` sous le droit `write`.

### La liste de rekey

Toute nouvelle colonne chiffrée suspendue à un projet doit être inscrite dans
`features/projects/src/server/repo/rekey.ts` (conversion du **tier d'un
projet**) et dans `projectsTree` (`copy.ts`). Rien ne peut le détecter : un blob
chiffré est indistinguable d'un autre. La liste de rekey ne cible une ligne que
par **une seule** colonne identifiante, d'où les clés de substitution là où la
paire naturelle serait composite.

Ce qui est **toujours** sous l'étage ouvert ne relève jamais de la conversion
d'un projet : les jetons des modules (`ft_git_credentials.secret_enc`,
`ft_deploy_credentials.secret_enc`), le cache git (`git_*`) et les cibles de
déploiement, qui appartiennent à l'espace et n'ont donc aucun tier de projet à
suivre.

### Une classe CSS redéfinie ne se voit pas

Ni TypeScript, ni ESLint, ni le build ne signalent une classe définie deux
fois dans un module de style ; la seconde gagne en silence.
`client/scripts/check-css-modules.mjs`, en tête du `ci` du client, échoue si
une classe est redéfinie seule dans son sélecteur. Le module de style de
Projets ne porte que ses écrans : la section git du style vit dans
`features/git/src/client/style.module.css`.

### Dokploy

Le dialogue avec Dokploy (tRPC, `target_kind`) est décrit dans
[Déploiements](../deploy/README.md) ; Projets n'en connaît que la liaison vers
une cible.

---

## 6. Configuration, quotas, notifications

Aucune variable d'environnement n'est propre au module.

**L'offre** ([Docs/QUOTAS.md](../../Docs/QUOTAS.md), valeurs de
`DevEye-Billing/src/server/plans.ts`) :

- `projects.pages` est un stock qui compte les projets en ligne des espaces du
  propriétaire : Gratuite 1, Pro 10. L'excédent se met en pause, le plus
  récemment publié d'abord ; une page en pause répond « introuvable » sans que
  son réglage ne bouge, et l'onglet Page publique le dit (`PlanPausedNotice`).
- Le domaine qui sert les pages relève de `domains.hosts` : Gratuite 0, Pro 3.
- Les projets eux-mêmes, leurs tâches et leurs messages n'ont aucune limite.

Une installation sans module de facturation n'a aucune limite.

**Notifications** : Projets ne notifie pas (`notifies: false`) ; le badge de
non-lus et la présence en direct tiennent lieu de signal.

---

## 7. Vérification

```bash
npm run ci            # l'app : lint, typecheck, tests, glue générée
npm run ci:features   # les modules : lint, typecheck serveur et client, tests
npm run test:features # les tests des modules seuls
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
  oublie ses projections), l'entrée `items` (domicile, titre à l'étage
  ouvert, `shareable` faux pour un gardé), la vue d'ensemble, et la page
  publique (lien stable, quota compté à la mise en ligne seulement, gardé et
  fenêtre refusés, racine puis chemin sur un domaine, chemin unique,
  publication qui tombe avec le passage en gardé) ;
- `usageProvider.test.ts` : le contrat publié (usage et comptes par élément,
  titre de secours, feature inconnue vide, frise d'un projet gardé ignorée,
  version reportée sur les seuls suiveurs ouverts, le sujet ravivé seulement
  quand quelque chose a changé, cibles de liaison et pose idempotente) ;
- `publicPage/routes.test.ts` : les routes publiques (introuvable pareil pour
  un lien inconnu, fermé, gardé ou en pause, domaine d'un autre espace refusé,
  options fermées par défaut, thème et accent, icône d'onglet, racine qui
  passe au suivant, cache, ETag du script) et `publicPage/view.test.ts` : la
  vue du tableau ;
- `accountExport.test.ts` : chaque table du module a un sort dans l'export du
  compte.

### Points d'attention à l'essai manuel

1. **Droits** : un rôle sans `projects` ne voit qu'une tuile désaturée.
2. **Espaces** : un projet de l'espace A est invisible depuis B, sauf projeté
   (onglet Partage de sa fiche, ouvert seulement). Il s'y lit et s'y édite
   alors avec sa pastille, ses liaisons nommées mais non modifiables, ses
   membres inconnus d'ici masqués, et son « + » absent.
3. **Chiffrement** : `content` illisible en base ; un projet `guarded` en espace
   personnel avec chiffrement actif déclenche l'invite, et passer un projet en
   `guarded` **retire ses liaisons** et sa page publique (les objets, eux,
   survivent).
4. **Direct, à deux onglets** : carte déplacée, message reçu, « X écrit… » qui
   **disparaît** quand l'onglet se ferme, contours de présence, badge non-lus.
5. **Archives** : une carte archivée quitte le tableau, apparaît dans
   l'Historique des réglages, s'ouvre en lecture seule.
6. **Onglets** : un projet neuf n'ouvre que le Tableau et la Frise (la Vue
   d'ensemble se déclare dans les réglages). Le « + » propose les six
   intégrations, cinq sans le module Hébergement ; annuler l'ajout ne change
   rien, le valider fait paraître l'onglet **et** l'ouvre. Retirer le dernier
   élément d'une feature renvoie au tableau et remet son entrée dans le « + ».
   Un rôle sans écriture sur `git`, `database` ou `audience` ne voit pas
   l'entrée correspondante ; un projet confidentiel n'a pas de « + » du tout.
7. **Dialogue de tâche** : sur un projet d'une seule tâche, le bloc « Dépend
   de » ne s'affiche pas du tout ; dès qu'il y a une autre tâche, il propose de
   la choisir. La popup prend la hauteur de son contenu et grandit avec la
   discussion jusqu'au bord de l'écran, sans second ascenseur.
8. **Page publique** : ouvrir le lien en navigation privée, déplacer une carte
   et la voir paraître en moins d'une minute et demie, ouvrir puis fermer les
   trois options. Sur un domaine vérifié, un premier projet à la racine, un
   second sous `/projet/<chemin>`, et la racine qui passe au second quand le
   premier ferme.
9. **Recherche du tableau** : un mot d'une sous-tâche ou le nom d'un assigné
   trouve la tâche ; glisser une tâche trouvée, effacer la recherche : les
   masquées n'ont pas bougé, et l'ordre tient après rechargement.

---

## 8. Limite connue

**Le live est local au processus** : deux instances derrière un proxy = salles
silencieusement séparées.
