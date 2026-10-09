# Git : les dépôts d'un espace

Git suit les dépôts GitHub d'un espace : branches, commits, releases et pull
requests sont lus par un service de fond et servis depuis un cache local, si
bien qu'ouvrir un dépôt est instantané et ne consomme aucun quota GitHub. Un
projet relie un dépôt ; la fiche du dépôt dans Git et l'onglet Git du projet
montrent la même chose. Compagnon de [Projets](../projects/README.md).

---

## 1. Le modèle

### Un dépôt est une entité de l'espace

Un dépôt appartient à l'espace (`git_repos`), avec son cache, son jeton et sa
synchronisation. Un projet n'en garde qu'une **liaison** : une ligne dans
`project_repo_links`, une table de Projets, et rien d'autre. Un dépôt peut donc
servir plusieurs projets, être synchronisé une seule fois sous un seul quota de
fournisseur, ou n'appartenir à aucun projet et être seulement regardé.

> **Supprimer l'un ne supprime jamais l'autre.** Délier un dépôt d'un projet
> laisse le dépôt, son historique et les autres projets qui s'en servent.
> Supprimer un dépôt laisse les projets, qui perdent seulement leur pointeur.
> Les deux clés étrangères de la table de liaison sont en `CASCADE` : c'est la
> **liaison** qui tombe, jamais ce qu'elle relie.

### Tout le cache est à l'étage ouvert

Un dépôt appartient à l'espace, pas à un projet : il ne peut suivre le
`security_tier` d'aucun d'eux. Tout ce qui pend à `git_repos` est chiffré sous
la clé de l'espace, à l'étage ouvert (`ctx.cipher()` dans les handlers,
`deps.cipherFor(ws)` dans le service). La feature ne demande donc **jamais** de
mot de passe, et le service de fond, qui tourne sans session, lit tout ce dont
il a besoin.

Corollaire : **un projet confidentiel n'a pas de dépôt.** `projects.repoLink`
le refuse, et passer un projet en confidentiel retire ses liaisons
(`projects.setSecurityTier`, qui l'inscrit dans la frise). La liaison est une
ligne en clair : rattacher un projet confidentiel à un dépôt nommé montrerait ce
que le palier est censé cacher.

### Ce qui doit être unique ne peut pas être chiffré

Le chiffrement est non déterministe : deux chiffrés du même `owner/repo`
diffèrent, et aucune contrainte d'unicité ne tiendrait dessus. D'où
`git_repos.slug_ref`, les 16 premiers caractères hexadécimaux du sha256 de
`owner/repo` en minuscules, sous `UNIQUE (workspace_id, slug_ref)`. Même motif
pour `name_ref` (branche), `tag_ref` (release) et `author_ref` (auteur, condensé
de l'adresse : l'adresse lisible vit dans le corps chiffré).

Ce condensé rend **`git.repoAdd` idempotente** : un dépôt déjà présent rend sa
ligne, jeton mis à jour, au lieu d'un doublon. Un projet peut « créer » un dépôt
sans savoir s'il existe ailleurs dans l'espace. Il rend aussi un dépôt
**non renommable** : `owner/repo` est son identité ; viser un autre dépôt, c'est
en ajouter un.

### Un dépôt, plusieurs projets ; un projet, plusieurs dépôts

La clé primaire de `project_repo_links` est le couple `(project_id, repo_id)` :
un projet réel se compose souvent d'un client, d'un serveur et de contrats
partagés, chacun dans son dépôt. `KEY idx_project_repo_links_repo` rend
« combien de projets utilisent ce dépôt » assez bon marché pour figurer dans la
liste, avant qu'on clique sur « Supprimer ».

Le module Git **ne lit aucune table de Projets**. Le nombre de projets qui
utilisent un dépôt, et lesquels, lui viennent du contrat que Projets publie
(`PROJECTS_USAGE_PROVIDER` : `countByItem`, `usageOf`), et c'est par ce même
contrat qu'il dit à Projets la version d'un projet (`applyVersion`, §3.6). Dans
l'autre sens, Projets demande au module si un dépôt existe et comment il
s'appelle (`GIT_ITEMS_PROVIDER` : `exists`, `labelOf`) avant de le relier.
Uptime lit le même contrat pour ses sources de déploiement (`list`,
`authorize`, `activity`, §3.6).

### L'ordre des dépôts appartient à l'utilisateur

`git_repos.sort_order` est posé par `git.repoReorder` et par rien d'autre ; un
nouveau dépôt prend le rang suivant, donc la fin de la liste. Le geste est le
glisser-déposer commun du SDK (`useDragReorder`). Pendant un glissé, la
relecture déclenchée par `git.list` est **retenue** et rejouée au relâchement :
une liste qui se réordonne sous le pointeur n'est pas un ordre.

### Le droit `git` est distinct de `projects`

Lire le dépôt d'un projet relève de `git: read`, pas de `projects`. L'onglet Git
d'un projet le dit quand le rôle ne l'accorde pas, plutôt que d'afficher un
écran vide. Relier ou délier un dépôt relève de `projects: write` : c'est le
projet qu'on modifie. Voir [`Docs/PERMISSIONS.md`](../../Docs/PERMISSIONS.md).

---

## 2. À l'usage

| Vue                        | Contenu                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dépôts**                 | tous les dépôts de l'espace, rangeables au glisser-déposer, dernière synchronisation, nombre de projets, cause d'un blocage, bande de progression pendant une synchronisation                               |
| **Un dépôt**               | graphe des commits, branches (avec leur avance et leur retard sur la branche par défaut), releases, pull requests, derniers commits, projets liés ouvrables d'un clic                                       |
| **Réglages → Sources**     | les jetons GitHub de l'espace : ajout, modification, suppression, et le nombre de dépôts que chacun sert. Le « + » du sélecteur de jeton y mène, et le dépôt adopte le jeton créé au retour                 |
| **Réglages d'un dépôt**    | Général (jeton, synchronisation, relecture complète, suppression), Partage entre espaces et Permissions par rôle ([`Docs/SETTINGS.md`](../../Docs/SETTINGS.md), [`Docs/SHARING.md`](../../Docs/SHARING.md)) |
| **Onglet Git d'un projet** | le même dépôt, vu depuis le projet                                                                                                                                                                          |

La fiche d'un dépôt et l'onglet Git d'un projet sont **le même composant**
(`RepoView`, composé par l'onglet à travers `GIT_CLIENT_PROVIDER`). Un dépôt
n'a pas à se présenter autrement selon la porte par laquelle on entre, et une
seconde implémentation divergerait au premier ajustement. Dans l'onglet d'un
projet, chaque dépôt est dans son cadre, y compris quand il n'y en a qu'un : le
cadre dit où finit ce que l'onglet montre.

La tuile d'accueil compte les dépôts de l'espace (`git.count`). Sans le droit
`git`, la tuile reste à sa place, à demi-opacité, et affiche « Accès
restreint » à la place de son contenu.

Désigner un dépôt (`RepoPicker`) se fait dans l'ordre **jeton → propriétaire →
dépôt**, parce que le jeton change le résultat des deux autres : sans lui GitHub
ne rend que le public, avec lui il rend aussi les dépôts privés du compte ou de
l'organisation. Avec un jeton, le propriétaire se choisit parmi les comptes qu'il
atteint ; les dépôts se cochent à plusieurs, et la saisie manuelle (noms séparés
par des virgules) reste offerte : la découverte dépend d'une API tierce qui peut
refuser (quota anonyme épuisé, propriétaire introuvable, jeton à portée réduite),
et un échec de liste ne doit pas empêcher d'ajouter un dépôt dont on connaît le
nom. Les dépôts déjà suivis sont marqués « déjà dans l'espace » plutôt
qu'écartés : les rechoisir est sans danger.

---

## 3. Comment ça marche

### 3.1 Les commandes

Vingt-quatre commandes sous le préfixe `git.`, en camelCase
(`src/contracts/commands.ts`) :

- **jetons** : `credentialList`, `credentialAdd`, `credentialUpdate`,
  `credentialRemove` ;
- **dépôts** : `count`, `repoList`, `repoGet`, `repoAdd`, `repoCandidates`,
  `ownerCandidates`, `repoReorder`, `repoUpdate`, `repoRemove`, `repoResync`,
  `repoSyncNow`, `repoSyncStatus`, `syncStatuses` ;
- **cache** : `branchList`, `commitList`, `commitGraph`, `authorMap`,
  `releaseList`, `pullRequestList`, `commitDetail`.

Toute commande qui prend un `repoId` commence par `loadRepo` : le dépôt doit
être visible de l'espace actif (chez lui, ou projeté ici), et `ctx.items.assert`
refuse en plus ce qu'une restriction de rôle masque ou passe en lecture seule.
`loadHomeRepo` exige en outre que le dépôt soit chez l'appelant : ses réglages
(le jeton se choisit parmi les clés de **son** espace) et sa suppression se font
au domicile ; une fenêtre lit et resynchronise.

**Trois lectures seulement sortent du cache** : `git.commitDetail` (le diff),
`git.ownerCandidates` (les comptes qu'atteint un jeton) et `git.repoCandidates`
(les dépôts d'un propriétaire) interrogent GitHub au moment de la demande. Ce
sont les seules dont la latence dépende d'une API tierce, et les écrans le
disent. Un diff pèse des ordres de grandeur de plus que la ligne qui le résume et
ne se regarde qu'une fois : le stocker chiffré ferait grossir la base sans
contrepartie. Le jeton d'un dépôt projeté se lit **chez lui**
(`ft_git_credentials` de son domicile, sous le codec de son espace).

Le filet de démarrage (`MUTATION_VERB` dans `src/features/_topics.ts`) cherche un
verbe juste après le point et ne reconnaît aucune commande en camelCase : un
`mutates` oublié ne produit aucun avertissement, et se relit à la main sur
chaque écriture.

### 3.2 L'ordonnanceur de fond (`GitSync`)

`src/server/service.ts`, sur un ticker du SDK :

| Constante                    | Valeur  | Rôle                                                                               |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `TICK_SECONDS`               | 30 s    | cadence de l'ordonnanceur                                                          |
| `BATCH`                      | 10      | dépôts traités par tour, en parallèle : borne ce que le serveur fait en même temps |
| `MIN_INTERVAL_SECONDS`       | 600 s   | délai minimal entre deux synchronisations d'un même dépôt                          |
| `RATE_LIMIT_BACKOFF_SECONDS` | 3 600 s | recul d'un dépôt dont le jeton a épuisé son quota GitHub                           |
| `HEAD_PAGES`                 | 5       | pages de 100 commits lues par tour pour la tête                                    |
| `BACKFILL_PAGES`             | 30      | pages lues par tranche de remontée de l'historique ancien                          |
| `BACKFILL_GAP_MS`            | 3 s     | répit entre deux tranches d'un historique inachevé                                 |
| `BRANCHES_PER_RUN`           | 10      | branches dont les commits propres sont lus par tour                                |
| `BRANCH_PAGES`               | 2       | profondeur de cette lecture par branche                                            |
| `MAX_COMPARISONS_PER_RUN`    | 12      | branches comparées à la branche par défaut par tour                                |

`listDue` rend les dépôts activés qui ont un jeton, jamais synchronisés d'abord,
puis les plus anciens ; les dépôts que l'offre tient en pause sont écartés dans
la requête. Un tour ne prend que ceux dont la dernière synchronisation remonte à
plus de `MIN_INTERVAL_SECONDS`, sauf ceux demandés à la main (`git.repoSyncNow`,
`git.repoResync`, l'ajout d'un dépôt et l'arrivée d'un jeton réveillent
l'ordonnanceur par `requestSync`). Deux gardes de ré-entrance : celle du ticker
et une carte des promesses en vol, pour ne jamais traiter deux fois le même
dépôt.

Un tour sur un dépôt enchaîne six étapes, dans l'ordre : Dépôt (branche par
défaut), Branches (upsert, puis élagage des branches disparues du distant),
Commits (tête, tranche d'historique, puis commits propres aux autres branches),
Comparaison des branches, Releases (puis `applyVersion`, §3.6) et Pull requests.
Chaque lecture renvoie son ETag en `If-None-Match` : un 304 ne coûte rien au
quota et ne change rien. L'espace n'est réveillé (`live.changed`) que si quelque
chose a changé ; un tour de 304 ne fait re-solliciter personne.

Sur échec, le dépôt garde son `last_sync_error` (chiffré) et, si GitHub a
répondu quota épuisé, un `last_sync_at` **futur** : c'est le seul moyen, avec un
tri par ancienneté, de le faire patienter sans bloquer les autres.

**La progression se sonde, elle ne se diffuse pas.** Les six étapes d'un tour
feraient re-solliciter tout l'écran six fois chez tous les membres, pour une
information qui n'intéresse que celui qui regarde. L'étape en cours vit dans une
table **en mémoire** du service : `git.repoSyncStatus` (sondée toutes les 700 ms
par la fiche ouverte) et `git.syncStatuses` (toutes les 1,5 s par la liste, en
un seul appel pour l'espace) la lisent sans requête ni déchiffrement. Hors
service (tests, démarrage), la réponse est « rien en cours », jamais une erreur.
Derrière deux instances, seule celle qui synchronise connaît l'avancement.

Le sondage n'a aucune limite de durée : relire un dépôt de plusieurs milliers de
commits prend des minutes, et le serveur est la seule autorité sur « c'est
fini ». Il retire l'entrée d'avancement dans un `finally`, échec compris, donc la
boucle s'arrête toujours. Deux corollaires dans `syncOne` :

- entre deux tranches d'historique, l'entrée d'avancement **survit** aux trois
  secondes de répit (étape Commits, chronomètre conservé), sans quoi l'interface
  conclurait « terminé » au milieu d'un travail qui va durer ;
- la tranche suivante est enchaînée par un **appel direct** à `syncOne`, armé
  par un `setTimeout(...).unref()` et non par `requestSync` : le dépôt vient
  d'être synchronisé, donc trie en dernier dans `listDue`, un tour en cours
  avalerait la relance, et c'est une reprise unique, pas une boucle. Un dépôt mis
  en pause par l'offre entre deux tranches s'arrête là. Un tour qui échoue ne
  relance pas de tranche : sur un quota épuisé, ce serait la rafale que le recul
  cherche à éviter.

### 3.3 L'historique complet

Un dépôt lit **tout** son historique, pas ses mille derniers commits. Trois
passes par tour, sur un seul `fetchCommits` :

- la **tête** (`since` = le plus récent connu) : courte, souvent vide ; sautée
  au tout premier tour, où la queue part elle aussi de HEAD ;
- la **queue** (`until` = `backfillUntil`) : la remontée de l'historique, par
  tranches de `BACKFILL_PAGES` jusqu'à toucher le premier commit, puis
  lève `backfillDone` et ne recommence jamais. Trois façons d'avoir fini : le
  distant n'a plus rien, la tranche est vide, ou la borne n'a pas reculé (ce qui
  protège d'une boucle quand plus de `BACKFILL_PAGES` pages partagent la même
  seconde) ;
- une passe **par branche** (`ref`), parce que `/commits` sans référence ne rend
  que la branche par défaut : tout ce qui ne vit que sur une branche de travail
  resterait invisible. Une branche dont la tête est déjà connue est sautée sans
  appel, ce qui rend cette passe gratuite en régime établi.

Tant que l'historique n'est pas complet, le dépôt enchaîne ses tranches sans
attendre les dix minutes du régime ordinaire : un historique à moitié remonté
fait mentir le graphe sur l'âge du dépôt.

> La borne de la remontée est mémorisée dans `sync_state` (`backfillUntil`), et
> **pas** déduite d'un `MIN(committed_at)` sur le cache : celui-ci mêle les
> commits de toutes les branches, et un seul commit ancien venu d'une branche
> latérale abaisserait le minimum, ferait repartir la tranche suivante de bien
> plus bas et sauterait tout l'historique intermédiaire de la branche principale
> sans que rien ne le signale.

> **La date d'un commit est celle du _committer_, pas de l'auteur.** C'est ce qui
> fait converger la remontée : `since` et `until` filtrent chez GitHub sur
> la date du committer, et borner les tranches sur la date d'auteur comparerait
> deux grandeurs différentes (un rebase, un cherry-pick ou une pull request
> fusionnée plus tard les séparent), avec une borne qui ne recule pas ou des
> commits sautés en silence. La borne `until` reçoit **une seconde de
> battement** : les horodatages du cache sont arrondis à la seconde, GitHub
> compare à la milliseconde, et sans ce +1 tout commit partageant la seconde de
> la borne serait sauté définitivement. Le prix est un commit relu par tranche,
> qu'`INSERT IGNORE` absorbe. L'auteur, lui, reste l'auteur : c'est `author` qui
> nomme et colore.

Les comparaisons de branches mémorisent le couple `base..tête` qui les a
produites (`compared_sha`) et ne recomparent que lorsqu'il diffère ; l'écran rend
`null` plutôt qu'un chiffre périmé dès qu'un côté a bougé. Une branche sans
ancêtre commun fait répondre 404 : elle est ignorée, les autres continuent. Un
quota épuisé, lui, remonte et interrompt le tour.

### 3.4 L'adaptateur GitHub

`src/server/github.ts`, lecture seule, sur le `fetch` global, derrière la
couture `GitHubClient` du service (remplaçable par un GitHub factice dans les
tests). Un quota se reconnaît à un 403 ou 429 avec `x-ratelimit-remaining` à
zéro, jamais au seul code : un 403 peut aussi être un dépôt privé sans droit. Un
appel authentifié a 20 s ; une découverte, 15 s.

`listOwnerRepos` essaie trois chemins, dans cet ordre, parce que GitHub n'expose
pas la même chose selon qui demande :

1. `/user/repos` quand le jeton appartient au propriétaire demandé : le **seul**
   endpoint qui rende ses dépôts privés (`/users/{login}/repos` ne rend que le
   public, même avec le jeton de l'intéressé, d'où l'aller-retour sur `/user`) ;
2. `/orgs/{owner}/repos` : une organisation, dont un jeton membre voit aussi les
   dépôts privés ;
3. `/users/{owner}/repos` : le repli public, qui marche **sans jeton**, sous le
   quota anonyme de GitHub, que l'écran annonce.

`listTokenOwners` rend les comptes qu'un jeton atteint : le sien, ses
organisations (`/user/orgs`) et les propriétaires des dépôts qu'il lit, parce
qu'un jeton à grain fin voit rarement `/user/orgs`. Chaque appel peut échouer
seul ; seul l'échec de tous remonte.

### 3.5 Les jetons

Les jetons GitHub appartiennent à l'espace (`ft_git_credentials`), chiffrés à
l'étage ouvert : un même jeton ouvre en général plusieurs dépôts, et le service
de fond doit les lire sans session. Le secret ne sort jamais : le client reçoit
`hasSecret`, et un champ laissé vide à la modification veut dire « garder celui
en place ». Ils se gèrent dans Réglages → Sources (`CredentialsPanel`), seul
endroit où une source se crée, se corrige ou se retire
([`Docs/SOURCES.md`](../../Docs/SOURCES.md)).

Il n'y a pas de clé étrangère de `git_repos` vers `ft_git_credentials` :
`removeCredential` met à NULL le `credential_id` des dépôts du jeton, puis
retire la ligne. Un dépôt sans jeton reste, cesse d'être lu (`listDue` l'écarte)
et le dit : « jeton retiré, synchronisation arrêtée ». Un jeton qui arrive sur
un dépôt qui n'en avait pas déclenche une synchronisation tout de suite.

### 3.6 Le contrat avec Projets

- `features/projects/src/server/repoLink.ts` porte `projects.repoList`,
  `projects.repoLink` et `projects.repoUnlink`, sous `projects: write`. Avant de
  relier, Projets demande au module si le dépôt est visible de l'espace du projet
  (`GIT_ITEMS_PROVIDER.exists`), et nomme les dépôts liés par `labelOf`. Sans
  module Git installé, relier est refusé en le disant.
- `features/projects/src/server/usageProvider.ts` publie
  `PROJECTS_USAGE_PROVIDER`, que le module lit pour le compte et la liste des
  projets qui utilisent un dépôt (ceux de l'espace appelant : un dépôt projeté
  montre les projets de la fenêtre, pas ceux de son domicile). Absent, la
  feature dégrade : zéro projet partout, aucune commande ne casse.
- **Ce qui a mis le dépôt en ligne**, pour Uptime : `activity(repoId, ws,
since)` interroge GitHub sur-le-champ avec le jeton du dépôt
  (`fetchWorkflowRuns`, `fetchDeployments`) : un workflow réussi sur la branche
  par défaut, un déploiement GitHub réussi hors environnement transitoire, ou
  l'un d'eux encore en cours. Un jeton sans le droit Actions ou Deployments en
  lecture répond par `error`, jamais par une exception ; l'aide du jeton le
  demande pour cet usage. Ces appels ne partent que sur un écart constaté par
  Uptime, jamais au sondage.
- **La version d'un projet suit la release.** Un projet dont `versionSource` est
  `github_release` prend pour version le tag de la dernière release **stable**
  (jamais une pré-version) du dépôt qu'il relie. Après avoir rangé les releases
  d'un tour, le service dit le tag au contrat (`applyVersion('git', repoId, ws,
tag)`), et c'est Projets qui décide quels projets liés la suivent (les siens,
  à l'étage ouvert, sur cette source) et réécrit leur corps. Un appel par tour
  qui a reçu des releases (un 304 ne le déclenche pas) ; si l'écriture échoue,
  le tour échoue, l'ETag des releases n'est pas retenu et le tour suivant
  réessaie. Le service ne ravive que le sujet `git` ; c'est Projets qui ravive
  `projects` quand une version a changé.
- Côté client, l'onglet Git d'un projet (`features/projects/src/client/Git/` :
  `Git.tsx`, `LinkRepoDialog.tsx`) compose `GIT_CLIENT_PROVIDER` sans importer
  le module : la liste des dépôts de l'espace, un dépôt relié en entier
  (`LinkedRepo`, avec « Synchroniser », le bouton de réglages commun, « Ouvrir
  Git » et « Délier »), et le dialogue d'ajout. Le menu « + » de la barre
  d'onglets du projet ouvre le même dialogue (`AddFeatureDialog`).

### 3.7 Le client

`src/client/index.tsx` déclare la tuile (`GitWidget`), la vue complète (`Git`),
les panneaux de réglages (`general` : `RepoGeneralPanel` ; `sources` :
`CredentialsPanel`), `cacheDurationMinutes: 0` (la vue d'un dépôt sonde
l'avancement, une instance en cache continuerait de sonder sans être vue) et le
provider client.

- `RepoDialog` **ajoute** des dépôts, et rien d'autre ; une fois ajouté, un dépôt
  se règle dans l'onglet Général de sa fiche (`RepoGeneralPanel` : jeton,
  synchronisation activée ou suspendue, relecture complète, suppression), là où
  le bouton de réglages commun mène. Les deux chargent les jetons de l'espace
  et, quand le « + » du sélecteur a ouvert Réglages → Sources, adoptent au retour
  le jeton qui vient d'être créé.
- `Git.tsx` possède le niveau de présence `l1` (l'identifiant nu du dépôt
  ouvert) : « qui regarde quel dépôt », et la cible d'une téléportation
  ([`Docs/LIVE.md`](../../Docs/LIVE.md)). La liste suit `git.list`, la fiche
  `git.repo`.
- `RepoView` charge graphe, branches, releases, derniers commits et pull
  requests depuis le cache, sonde l'avancement pendant une synchronisation
  (700 ms, avec 12 s de grâce au démarrage : la commande rend la main avant que
  l'ordonnanceur ait inscrit une étape), et remonte l'état à l'en-tête, dont les
  boutons se désactivent sous le voile. Le voile couvre toute la boîte et son
  panneau est en `position: sticky`, calé sur le corps défilant de la popup : un
  contenu plus haut que la fenêtre centrerait sinon le texte hors écran.
- Les panneaux montrent 15 lignes (10 pour les commits et les pull requests,
  plus hautes) puis renvoient vers un dialogue « voir tout » ; les commits y sont
  paginés par curseur `(committedAt, id)`, cinquante par page.
- `CommitDialog` lit le diff chez GitHub à l'ouverture, et l'annonce ; les
  fichiers sont repliés par défaut, un commit de fusion en touchant parfois cent.

**Le graphe dessine sur un canvas** (`CommitGraph`). Un point par commit, la
date en abscisse et l'heure de la journée en ordonnée : la dispersion veut dire
quelque chose. Trois choix :

1. **un canvas** pour le nuage, redessiné seulement quand les données, la largeur
   ou l'auteur mis en avant changent ; un élément SVG par commit donnait autant
   de nœuds à mettre en page, et toute l'interface ralentissait dès quelques
   milliers de commits. Les axes restent en SVG : une vingtaine d'éléments de
   texte, qui suivent le thème ;
2. **une charge utile colonnaire** (`gitCommitPointsSchema` : `count`, `shas`
   concaténés, `committedAt`, `authorIndex`) : trois tableaux parallèles au lieu
   d'un tableau d'objets, et aucune allocation d'objet côté client
   (`Float32Array` pour les coordonnées) ;
3. **un index spatial** pour le survol : les points sont rangés en seaux par
   colonne de 14 px, une recherche n'en examine que trois.

Le graphe porte tout l'historique, avec une borne de sécurité à **100 000
points** (`GRAPH_MAX_POINTS`) pour qu'un dépôt monstrueux ne fasse pas exploser
une trame WebSocket ; au-delà, ce sont les commits **anciens** qui sont écrêtés,
et l'interface dit combien de points sont affichés.

**La légende peut réunir les auteurs sous un membre.** Une même personne commite
sous plusieurs adresses. `git.authorMap` rattache un auteur à un membre de
l'espace (l'appartenance est vérifiée par la façade `members.list()`), et le
réglage « N'afficher que les membres rattachés » du même dialogue
(`AuthorMapDialog`, activé par défaut) fait disparaître les auteurs git au
profit de la personne, qui réunit leurs points et leurs commits. Le regroupement
se fait **côté client**, dans un `useMemo` : la réponse du serveur reste la même
pour tout le monde. Il est **local au navigateur** (`prefs.ts`, `localStorage`),
pas une propriété de l'espace : deux personnes peuvent lire le même graphe
différemment. La liste du dialogue reste complète, regroupement ou non : c'est
là qu'on rattache. Le dialogue s'ouvre sans le droit d'écriture (il porte un
réglage personnel) ; ce sont les sélecteurs de rattachement qui s'y désactivent.
Un auteur rattaché prend la **couleur de son compte**, la même que sa présence
en direct : la façade `members.list()` (capacité `members.read`, la seule du
manifest) rend la couleur avec chaque membre, `null` sur un compte jamais
colorié (repli `defaultUserColor`). Un auteur non rattaché a une teinte
déterministe dérivée de son empreinte.

### 3.8 Le partage entre espaces

`shareTier: 'open'` : un dépôt se projette dans un autre espace, s'y déplace ou
s'y copie ([`Docs/SHARING.md`](../../Docs/SHARING.md)). L'entrée `items` du
serveur donne le domicile et le nom d'un dépôt visible (`homeOf`, `labelOf`), et
porte `move` et `copy` :

- `copy.ts` décrit l'arbre d'un dépôt (`gitTree`) : la ligne de `git_repos`
  (cellules scellées `content`, `last_sync_error`, `sync_state` ; unicité sur
  `slug_ref`) et les cinq tables du cache, marquées `cache`. Le jeton, le
  dernier état et l'état de synchronisation ne suivent pas (`omit`) : le jeton
  est une source de l'espace quitté, et une copie va relire son historique.
  `admit` contrôle le quota `repos` dans l'espace d'arrivée.
- `move.ts` rescelle les cellules de l'arbre sous la clé de l'espace d'arrivée,
  fait suivre le `workspace_id` des tables du cache, met `credential_id` à NULL
  (le dépôt arrive sans jeton, donc sans synchronisation, état que la feature
  sait dire), range le dépôt en fin de liste, et refuse si `slug_ref` est déjà
  pris là-bas.
- Les listes déduisent `ctx.items.restrictions()` : un dépôt qu'une restriction
  masque pour ce rôle disparaît plutôt que de figurer grisé, et la tuile compte
  ce que la liste montre. `git.repoRemove` appelle `ctx.items.forget` : sans ce
  ménage, projections et restrictions s'appliqueraient au prochain dépôt à
  hériter de l'identifiant.

### 3.9 L'export du compte

`src/server/accountExport.ts` ([`Docs/ACCOUNT_EXPORT.md`](../../Docs/ACCOUNT_EXPORT.md)) :
`git_repos` dans `depots.json` (corps déchiffré, sans `sync_state`),
`ft_git_credentials` dans `jetons.json` (sans le secret). Le cache (commits,
branches, auteurs, pull requests, releases) n'est pas exporté : il reste chez le
fournisseur, d'où la synchronisation le relit.

---

## 4. Carte du code

```
deveye-feature.json                 l'allowlist des six tables historiques (git_repos, git_branches, git_commits,
                                    git_commit_authors, git_pull_requests, git_releases)
package.json                        deveye-feature-git
src/index.ts, src/manifest.ts       l'entrée isomorphe ; le descripteur étalé, ressources git.count / git.list / git.repo,
                                    capacité members.read, quota repos, réglages { feature: ['sources'], item: ['general'] }
src/contracts/domain.ts             dépôt, jeton, branches, commits (dont la forme colonnaire du graphe), releases, PR,
                                    diff, état de synchronisation
src/contracts/commands.ts           les vingt-quatre commandes (préfixe `git.`)

src/server/index.ts                 serverEntry : dépôt, handlers, service, `items` (domicile, nom, move, copy),
                                    quota `repos`, export du compte, provider GIT_ITEMS_PROVIDER offert à Projets, Audit et Uptime
src/server/repo.ts                  dépôts, jetons (ft_git_credentials), cache, listDue et stock du quota ; sur SdkQueryable
src/server/_shared.ts               StoredRepo, slugRef, readJson, loadRepo / loadHomeRepo, repoCipher, toRepo, toCredential,
                                    le singleton du service (setSync / syncOf / requestSync), le contrat de Projets
src/server/handlers.ts              l'agrégat de credentials.ts (les jetons), crud.ts (les dépôts, leur ordre, les gestes
                                    qui réveillent ou interrogent le service) et read.ts (le cache, le graphe, le diff)
src/server/service.ts               GitSync : l'ordonnanceur de fond
src/server/github.ts                l'adaptateur GitHub, lecture seule (ETags, since / until / ref, découverte)
src/server/copy.ts, move.ts         l'arbre d'un dépôt ; sa copie et son déplacement entre espaces
src/server/accountExport.ts         l'export du compte
src/server/uninstall.sql            DROP de ft_git_credentials (les tables historiques restent)
src/server/*.test.ts                handlers (harnais SDK), service (GitHub factice), github (décodeurs, fetch simulé),
                                    repo (le SQL des pauses et du stock), accountExport

src/client/index.tsx                clientEntry : tuile, vue complète, panneaux Général et Sources, provider client
src/client/Git.tsx                  liste + fiche ; possède le niveau live `l1`
src/client/RepoList.tsx             les cartes et leur glisser-déposer (useDragReorder du SDK)
src/client/RepoDetail.tsx           en-tête d'un dépôt + RepoView + projets liés
src/client/RepoView.tsx             le cœur partagé avec l'onglet Git d'un projet
src/client/Rows.tsx                 lignes de branche / release / PR / commit, partagées avec les dialogues « voir tout »
src/client/ListDialog.tsx           le « voir tout » d'un panneau ; les commits paginés
src/client/AuthorMapDialog.tsx      rattachement des auteurs aux membres + regroupement
src/client/RepoDialog.tsx           ajouter des dépôts (le « + » du jeton ouvre Réglages → Sources)
src/client/RepoGeneralPanel.tsx     l'onglet Général d'un dépôt : jeton, synchronisation, relecture complète, suppression
src/client/RepoPicker.tsx           jeton → propriétaire → dépôt, partagé avec RepoDialog
src/client/CredentialsPanel.tsx     les jetons GitHub (panneau Sources de la feature)
src/client/CommitGraph.tsx          le graphe sur canvas (scale.ts, useElementWidth.ts)
src/client/CommitDialog.tsx         le détail d'un commit et son diff
src/client/PullRequestDialog.tsx    le détail d'une pull request
src/client/GitWidget.tsx            la tuile d'accueil (git.count)
src/client/provider.tsx             ce que l'onglet d'un projet compose (GIT_CLIENT_PROVIDER)
src/client/prefs.ts                 préférences d'affichage, locales au navigateur
src/client/api.ts                   featureApi(manifest)
src/client/style.module.css         la feuille du module
```

Côté Projets : `features/projects/src/server/repo/links.ts` (la table
`project_repo_links`, ses lectures et ses comptes),
`features/projects/src/server/repoLink.ts` (les trois commandes de liaison),
`features/projects/src/server/usageProvider.ts` (`PROJECTS_USAGE_PROVIDER`) et
`features/projects/src/client/Git/` (l'onglet d'un projet).

---

## 5. Les tables

| Table                                                                                    | À qui   | Contenu                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_repos`                                                                              | socle   | un dépôt : `slug_ref` (unique par espace), `credential_id` (sans clé étrangère), `enabled`, `sort_order`, `default_branch`, `last_sync_at`, `last_sync_error` et `sync_state` chiffrés, `content` chiffré (`owner`, `repo`) |
| `git_branches`, `git_commits`, `git_commit_authors`, `git_pull_requests`, `git_releases` | socle   | le cache, en cascade sur le dépôt ; les condensés (`name_ref`, `tag_ref`, `author_ref`, `sha`) et les dates en clair, le reste chiffré ; `git_commit_authors.user_id` porte le rattachement à un membre                     |
| `ft_git_credentials`                                                                     | module  | les jetons GitHub de l'espace, `secret_enc` chiffré à l'étage ouvert ; `uninstall.sql` la détruit                                                                                                                           |
| `project_repo_links`                                                                     | Projets | la liaison `(project_id, repo_id)`, en cascade des deux côtés                                                                                                                                                               |

Les six tables historiques sont créées par les migrations du socle et listées
dans l'allowlist de `deveye-feature.json`, qui les dispense du préfixe
`ft_git_`. Le module n'a pas de `migrationsDir` : une nouvelle table
inaugurerait `src/server/migrations/` avec ce préfixe.

---

## 6. Configuration

Aucune variable d'environnement. Les appels sortants vont vers
`https://api.github.com`, par le `fetch` global.

---

## 7. Les quotas de l'offre

Un dépôt suivi interroge GitHub à chaque tour, à vie : c'est ce que l'offre
borne. Le manifest déclare le quota `repos` (un **stock**, libellé « dépôts
suivis »), ce qui donne la limite `git.repos`
([`Docs/QUOTAS.md`](../../Docs/QUOTAS.md)). Les valeurs sont celles du module
de facturation des comptes (`src/server/plans.ts` de Billing) : **3** dépôts en
offre gratuite, **20** en Pro, tous espaces du propriétaire confondus. Une
installation sans module de facturation n'a aucune limite.

Le contrôle est dans `git.repoAdd` (`ctx.quota.assert('repos', …)`), **après**
la recherche qui rend l'ajout idempotent : remettre à jour un dépôt déjà suivi
n'en ajoute aucun et ne doit jamais buter sur la limite ; et dans `admit` de
`copy.ts` pour une copie. Un déplacement ne change rien au compte. Le stock est
listé par `listStockRepos`, du plus ancien au plus récent : après un retour à
une offre plus basse, l'excédent passe en pause, le plus récent d'abord. Un
dépôt en pause est écarté de `listDue`, refuse `git.repoSyncNow`,
`git.repoResync` et `git.commitDetail` (`ctx.quota.assertActive`), et se
présente avec `planPaused` à l'écran.

---

## 8. Notifications

Git n'émet aucun avis (`notifies: false` dans le registre).

---

## 9. Tests

```bash
npm run test:features
```

depuis `DevEye/`. Les tests du module tournent sans base ni réseau.

---

## 10. Les limites

- **Tout est du sondage** : aucun webhook n'est reçu ; seule la question
  d'Uptime sur une mise en ligne part à la demande. Le coût est borné par les
  ETags et par le budget d'appels de chaque tour.
- **GitHub seulement.** L'adaptateur est isolé dans `src/server/github.ts`,
  derrière la couture `GitHubClient` du service.
- **Un dépôt ne se renomme pas** : `owner/repo` est son identité (§1).
