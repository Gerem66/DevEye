# Git — les dépôts d'un espace

> Écrit le 7 août 2026, à la fin du chantier qui a sorti le git du module
> Projets ; relu le 21 août 2026 (sources, coquille de réglages), et le 28 août
> 2026, au rapatriement de la feature en module (`features/git`, §8).
> Compagnon de [Projets](../projects/README.md) : celui-ci suit le travail,
> celui-là suit le code. Il dit **pourquoi** ; le code dit comment.

---

## 1. Le renversement

Le git existait avant cette feature, mais comme une **propriété d'un projet** :
`project_repos` était clé sur `project_id`, et tout le cache — commits,
branches, releases, pull requests, auteurs — l'était aussi.

Trois symptômes, que les retours d'usage ont pointés séparément sans qu'on voie
d'abord qu'ils avaient la même cause :

1. Les **jetons d'accès** se créaient depuis l'intérieur d'un projet alors
   qu'ils appartiennent à l'espace — et ne pouvaient nulle part être supprimés
   ni modifiés. Pire : un jeton **Dokploy** n'était pas créable du tout, alors
   que l'onglet Déploiement en réclamait un et renvoyait vers un écran incapable
   de le fournir.

    > Ce chantier les a donc tous accueillis ici, y compris les clés Dokploy, qui
    > n'avaient rien à y faire : c'était le seul écran capable de gérer un secret.
    > Elles sont parties dans la feature Déploiement ([Déploiements](../deploy/README.md)),
    > qui n'existait pas encore à l'époque, puis dans la table de son module
    > (`ft_deploy_credentials`, migration 099). Les jetons GitHub ont suivi le
    > même chemin à leur tour (`ft_git_credentials`, migration 100), et la table
    > commune `workspace_credentials` a disparu avec le comportement partagé
    > (`_credentials.ts`) : chaque module possède ses accès, et poser la clé qui
    > met en production ne relève pas du droit de lire des dépôts.

2. Un dépôt partagé par deux projets aurait été **synchronisé deux fois**, dans
   deux caches distincts, sous deux quotas de fournisseur.
3. Un dépôt qu'on veut seulement **regarder**, sans projet autour, n'avait pas
   de place.

Le dépôt est donc devenu une **entité de l'espace**. Un projet n'en garde qu'une
**liaison** — une ligne dans `project_repo_links`, et rien d'autre.

> **Supprimer l'un ne supprime jamais l'autre.** Délier un dépôt d'un projet
> laisse le dépôt, son historique et les autres projets qui s'en servent.
> Supprimer un dépôt laisse les projets, qui perdent seulement leur pointeur.
> Les deux clés étrangères de la table de liaison sont en `CASCADE` : c'est la
> **liaison** qui tombe, jamais ce qu'elle relie.

---

## 2. Les trois invariants

### 2.1 Le cache git est **toujours** à l'étage ouvert

Un dépôt appartient à l'espace, pas à un projet : il ne peut donc suivre le
`security_tier` d'aucun d'eux. Tout ce qui pend à `git_repos` est chiffré sous
la clé de l'espace, à l'étage ouvert, une fois pour toutes (`ctx.cipher()` dans
les handlers, `deps.cipherFor(ws)` dans le service).

Trois conséquences, toutes bonnes :

- la feature Git ne demande **jamais** de mot de passe ;
- le service de fond, qui tourne sans session, lit tout ce dont il a besoin ;
- la course qui obligeait l'ancien `markSynced` à porter une garde atomique sur
  `projects.security_tier` — le projet basculant en confidentiel entre la
  sélection d'un dépôt et l'écriture de son résultat — **a disparu avec sa
  cause**, pas avec sa garde.

Corollaire assumé : **un projet confidentiel n'a pas de dépôt.**
`projects.repoLink` le refuse, et passer un projet en confidentiel retire sa
liaison (`projects.setSecurityTier`). Ce n'est pas seulement que la
synchronisation ne pourrait pas le lire : la liaison est une ligne en clair, et
rattacher un projet confidentiel à un dépôt nommé montrerait précisément ce que
le palier est censé cacher.

### 2.2 Ce qui doit être unique ne peut pas être chiffré

Le chiffrement est non déterministe : deux chiffrés de `gerem66/DevEye`
diffèrent, et aucune contrainte d'unicité ne tiendrait dessus. D'où
`git_repos.slug_ref` — les 16 premiers caractères du sha256 de `owner/repo` en
minuscules — sous `UNIQUE (workspace_id, slug_ref)`. Même motif que `name_ref`
pour une branche, `tag_ref` pour une release, `author_ref` pour un auteur.

C'est ce condensé qui rend **`git.repoAdd` idempotente** : le même dépôt déjà
présent rend sa ligne (jeton mis à jour) au lieu d'un doublon. Un projet peut
donc « créer » un dépôt sans savoir s'il existe déjà ailleurs dans l'espace, et
un dépôt n'est jamais synchronisé deux fois.

### 2.3 n dépôts par projet, n projets par dépôt

La clé primaire de `project_repo_links` est le couple `(project_id, repo_id)`
depuis la migration 069. L'invariant « un projet, un dépôt » qui la précédait
était une supposition, pas une contrainte du domaine : un projet réel se compose
souvent d'un client, d'un serveur et de contrats partagés, chacun dans son
dépôt — et une clé sur `project_id` seul faisait _remplacer_ là où l'on voulait
_ajouter_.

Les liaisons d'un projet ont désormais la même forme — dépôts (069), services
surveillés (067), bases de données (068), cibles de déploiement (080) — et
c'est la forme juste : ce sont des objets d'espace, pas des propriétés d'un
projet. Les quatre tables sont celles de **Projets**
(`features/projects/src/server/repo/links.ts`),
et le module Git ne lit aucune d'elles : le nombre de projets qui utilisent un
dépôt, et lesquels, lui viennent du contrat que Projets offre
(`PROJECTS_USAGE_PROVIDER`, `usageOf` et `countByItem`), et c'est par ce même
contrat qu'il lui dit la version d'un projet (`applyVersion`, voir §5).

`KEY idx_project_repo_links_repo` rend « combien de projets utilisent ce dépôt »
assez bon marché pour figurer dans la liste, avant qu'on clique sur
« Supprimer » — pas après.

Côté écran, l'onglet Git d'un projet affiche chaque dépôt à la suite, **chacun
dans son cadre, y compris quand il n'y en a qu'un**.

Ce ne fut pas toujours le cas : le cadre n'apparaissait qu'à partir de deux
blocs, au motif qu'il n'aurait rien à séparer sur un dépôt unique. Le
raisonnement ne tenait qu'à moitié. Un cadre sépare, mais il dit aussi **où
finit ce que l'onglet montre** : sans lui, un dépôt seul se confondait avec le
fond de la popup, et l'onglet ne ressemblait plus à ses voisins du même projet.
Les onglets Bases de données, Audience et Déploiement suivent la même règle, pour
que deux onglets d'un même projet ne se distinguent pas par ce genre de détail.

L'onglet lui-même **n'apparaît qu'à partir du premier dépôt relié** : sans
liaison, il repart dans le menu « + » de la barre, qui rouvre le même dialogue
d'ajout. Voir [Projets](../projects/README.md) §2.

---

## 3. Ce que ça donne à l'usage

| Vue                        | Contenu                                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dépôts**                 | tous les dépôts de l'espace, dernière synchro, nombre de projets, cause d'un blocage                                                                                                                                                                                         |
| **Un dépôt**               | graphe des commits, branches, releases, pull requests, derniers commits, projets liés                                                                                                                                                                                        |
| **Réglages → Sources**     | les jetons GitHub de l'espace, ajout / modification / suppression, avec ce que chacun sert : l'ancien bouton « Jetons GitHub », absorbé par la coquille commune. Le « + » du sélecteur de jeton (RepoPicker / RepoDialog) y mène, et le dépôt adopte le jeton créé au retour |
| **Réglages d'un dépôt**    | partage entre espaces et permissions par rôle (`Docs/SETTINGS.md`, `Docs/SHARING.md`)                                                                                                                                                                                        |
| **Onglet Git d'un projet** | le même dépôt, vu depuis le projet                                                                                                                                                                                                                                           |

Les deux derniers écrans sont **le même composant** (`RepoView`, composé par
l'onglet d'un projet à travers `GIT_CLIENT_PROVIDER`). Un dépôt n'a pas à se
présenter autrement selon la porte par laquelle on entre, et une seconde
implémentation aurait divergé au premier ajustement.

L'interconnexion va dans les deux sens : depuis un projet on atteint son dépôt,
et depuis un dépôt on ouvre en un clic chacun des projets qui l'utilisent.

---

## 4. Carte du code

### Le module — `DevEye/features/git/`

```
deveye-feature.json                 l'allowlist des six tables historiques (git_repos, git_branches, git_commits,
                                    git_commit_authors, git_pull_requests, git_releases)
package.json                        deveye-feature-git
src/index.ts, src/manifest.ts       l'entrée isomorphe ; le descripteur étalé, `shareTier: 'open'`,
                                    ressources git.count / list / repo, capacité `members.read`, onglet Sources
src/contracts/domain.ts             dépôt, jeton, branches, commits, releases, PR, diff, sync (l'ex domain/git.ts)
src/contracts/commands.ts           les vingt-trois commandes (préfixe unique `git.`)

src/server/index.ts                 serverEntry : dépôt, handlers, service, `items` (domicile et `owner/repo` d'un dépôt),
                                    provider GIT_ITEMS_PROVIDER offert à Projets
src/server/repo.ts                  dépôts, jetons (ft_git_credentials), synchronisation, cache ; sur SdkQueryable
src/server/_shared.ts               StoredRepo, slugRef, loadRepo / loadHomeRepo, toRepo, toCredential,
                                    le singleton du service (setSync / syncOf / requestSync), le contrat de Projets
src/server/handlers.ts              l'agrégat : credentials.ts (les quatre gestes de jetons), crud.ts (les dépôts,
                                    leur ordre, les gestes qui réveillent ou interrogent le service), read.ts (le cache)
src/server/service.ts               GitSync : l'ordonnanceur de fond (ticker à deux minutes, tranches de backfill)
src/server/github.ts                l'adaptateur GitHub, lecture seule (ETags, since / until, trois chemins de découverte)
src/server/uninstall.sql            DROP de ft_git_credentials (les tables historiques restent)
src/server/*.test.ts                handlers (harnais SDK), service (GitHub factice), github (les décodeurs)

src/client/index.tsx                clientEntry : widget, vue complète, panneau Sources, provider client
src/client/Git.tsx                  liste des dépôts + fiche ; possède le niveau live `l1` (l'identifiant nu du dépôt)
src/client/RepoList.tsx             les cartes + le glisser-déposer d'ordonnancement
src/client/RepoDetail.tsx           en-tête d'un dépôt + RepoView + projets liés
src/client/RepoView.tsx             ⟵ le cœur partagé avec l'onglet Git d'un projet
src/client/Rows.tsx                 lignes de branche / release / PR / commit, partagées
src/client/ListDialog.tsx           le « voir tout » d'un panneau
src/client/AuthorMapDialog.tsx      rattachement des auteurs aux membres + regroupement
src/client/RepoDialog.tsx           ajouter / modifier / supprimer un dépôt (le « + » du jeton ouvre Réglages → Sources)
src/client/RepoPicker.tsx           jeton → propriétaire → dépôt, partagé avec les Projets
src/client/CredentialsPanel.tsx     les jetons GitHub (panneau Sources du manifest)
src/client/CommitGraph.tsx          le graphe sur canvas (scale.ts, useElementWidth.ts)
src/client/CommitDialog.tsx, PullRequestDialog.tsx, GitWidget.tsx
src/client/provider.tsx             ce que l'onglet d'un projet compose (GIT_CLIENT_PROVIDER)
src/client/prefs.ts                 préférences d'affichage, locales au navigateur
src/client/api.ts, format.ts        featureApi(manifest) ; les libellés
src/client/style.module.css         la feuille du module
```

### Ce qui reste dans l'app — `DevEye/src/`

```
db/migrations/064_git_repos.sql      table rase de l'ancien schéma, 7 tables
db/migrations/100_git_credentials.sql  les jetons GitHub dans la table du module, la clé étrangère retirée,
                                       workspace_credentials supprimée
features/projects/src/server/repo/links.ts       project_repo_links : la table de Projets, ses lectures et ses comptes
features/projects/src/server/repoLink.ts         les trois commandes de liaison ; l'existence d'un dépôt par GIT_ITEMS_PROVIDER
features/projects/src/server/usageProvider.ts    PROJECTS_USAGE_PROVIDER : ce que le module demande à Projets, et la version
                                                 d'un projet qui suit une release (applyVersion)
```

Le contrat de Projets (`features/projects/src/contracts/commands.ts`) n'en
porte que trois : `projects.repoList` / `repoLink` / `repoUnlink`. Elles ne
manipulent qu'un `repoId`. `features/projects/src/client/Git/` se réduit à `Git.tsx` (enveloppe
mince) et `LinkRepoDialog.tsx` (choisir un dépôt existant, ou en créer un),
composés sur `GIT_CLIENT_PROVIDER`.

---

## 5. Pièges, et pourquoi ils existent

### Le filet de démarrage ne couvre pas ce module

`MUTATION_VERB` (`src/features/_topics.ts`) cherche un verbe **juste après le
point** (`notes.add`). Les commandes d'ici sont en camelCase sous un préfixe
unique (`git.repoAdd`) : **il n'en verra aucune**, exactement comme pour les
projets. Un `mutates` oublié ne produira donc aucun avertissement. (Une seule
exception, `git.syncStatuses`, dont le verbe suit le point : elle figure dans
`NON_MUTATING`, le filet passant aussi sur les commandes des modules.)

→ **Relire `mutates` à la main** sur chaque écriture ajoutée. En revanche, un
préfixe absent de `COMMAND_PREFIX_TOPIC` **fait échouer le démarrage** — c'est
un contrat, pas une heuristique.

### Le cache git ne suit aucun tier

Le cache git ne figure pas dans la liste de rekey de Projets
(`features/projects/src/server/repo/rekey.ts`) : un dépôt appartient à
l'espace et non à un projet, il est chiffré sous la clé de l'espace à l'étage
ouvert, une fois pour toutes.

### Le droit `git` est distinct de `projects`

Lire le dépôt d'un projet relève de `git: read`, pas de `projects`. L'onglet Git
d'un projet le dit explicitement quand le rôle ne l'accorde pas, plutôt que
d'afficher un écran vide qui se lirait comme un bug.

⚠️ **Les rôles existants n'accordent pas `git`** — _fail-closed_, voir
Docs/WORKSPACES.md §3. Le propriétaire a tout d'office ; les autres membres doivent
recevoir le droit dans « Gérer l'espace › Rôles ».

### La progression se sonde, elle ne se diffuse pas

Les six étapes d'un tour feraient re-solliciter tout l'écran six fois d'affilée
chez **tous** les membres de l'espace, pour une information qui n'intéresse que
celui qui a pressé le bouton. D'où `git.repoSyncStatus`, sondée toutes les
700 ms par la seule vue concernée, et une unique invalidation à la fin.
`git.syncStatuses` fait la même chose pour la liste, en un seul appel — les deux
ne lisent qu'une table **en mémoire** du service (`syncOf()`, le singleton posé
par `createService`), sans requête ni déchiffrement, et c'est ce qui rend le
sondage défendable. Sans service monté (tests, boot en cours), la réponse est
« rien en cours », jamais une erreur.

Corollaire assumé, vrai de tout le direct : derrière deux instances, seule celle
qui synchronise connaît l'avancement.

**Le sondage n'a aucune limite de durée, et c'est délibéré.** Il en avait une —
trois minutes — et elle était fausse : relire un dépôt de plusieurs milliers de
commits prend plus longtemps, et la barre disparaissait en plein travail. Le
serveur est la seule autorité sur « c'est fini » ; il retire l'entrée
d'avancement dans un `finally`, échec compris, donc la boucle s'arrête toujours.

Deux corollaires côté serveur, dans `GitSync.syncOne` (`service.ts`) :

- entre deux tranches de rapatriement d'historique, l'entrée d'avancement
  **survit** aux trois secondes de répit — sans quoi l'interface concluait
  « terminé » au milieu d'un travail qui allait durer des minutes ;
- la tranche suivante est enchaînée par un **appel direct** à `syncOne`, posé
  par un `setTimeout(...).unref()` et non par `forced` + `tick()` ni par un
  ticker du SDK : le dépôt vient d'être synchronisé, il trie donc en dernier
  dans `listDue`, un tour déjà en cours aurait avalé la relance, et ce n'est
  pas une boucle mais une reprise unique. Une tranche perdue laisserait
  l'historique incomplet **et** une barre figée.

### La version d'un projet suit la release, par le contrat de Projets

Un projet dont `versionSource` est `github_release` prend pour version le tag
de la dernière release **stable** (jamais une pré-version) du dépôt qu'il
relie. Le service ne lit ni n'écrit aucune table de Projets : après avoir
rangé les releases d'un tour, il dit le tag au contrat (`applyVersion('git',
repoId, ws, tag)`), et c'est Projets qui décide quels projets liés la suivent
(les siens, à l'étage ouvert, sur cette source) et réécrit leur corps. Un
appel par tour qui a reçu des releases (un 304 ne le déclenche pas), et le
tour échoue si l'écriture échoue : l'ETag des releases n'est alors pas
retenu, et le tour suivant réessaie.

Le service ne ravive que `git` ; c'est Projets qui ravive `projects` depuis
son module, quand `applyVersion` a changé la version d'un projet
(`deps.live.changed`, jamais sans changement).

### Désigner un dépôt : l'ordre des champs est le sujet

`RepoPicker` pose **jeton → propriétaire → dépôt**, dans cet ordre, parce que le
jeton _change le résultat_ des deux autres : sans lui GitHub ne rend que le
public, avec lui il rend aussi les dépôts privés du compte ou de l'organisation.
Le placer sous la liste revenait à demander de choisir avant d'avoir dit ce que
la liste devait contenir. La liste se recharge donc à chaque changement de l'un
ou de l'autre, et d'eux seuls.

Avec un jeton, le propriétaire se choisit parmi les comptes qu'il atteint
(`listTokenOwners`) : le sien, ses organisations (`/user/orgs`) et les
propriétaires des dépôts qu'il lit, car un jeton à grain fin voit rarement
`/user/orgs`. Les dépôts se cochent à plusieurs ; à la main, leurs noms se
séparent par des virgules.

`listOwnerRepos` (`github.ts`) essaie trois chemins, parce que GitHub n'expose
pas la même chose selon qui demande :

1. **`/user/repos`** quand le jeton appartient au propriétaire demandé — le
   **seul** endpoint qui rende ses dépôts privés. `/users/{login}/repos` ne rend
   que le public _même avec le jeton de l'intéressé_ : c'est le piège de cette
   API, et la raison de l'aller-retour sur `/user` ;
2. **`/orgs/{owner}/repos`** — une organisation, dont un jeton membre voit aussi
   les dépôts privés ;
3. **`/users/{owner}/repos`** — le repli public, qui marche **sans jeton**.

La saisie manuelle reste offerte, et ce n'est pas un détail : la découverte
dépend d'une API tierce qui peut refuser (quota anonyme épuisé, propriétaire
introuvable, jeton à portée réduite). Sans repli, un échec de liste empêcherait
d'ajouter un dépôt dont on connaît parfaitement le nom.

### L'historique complet, et la date qui le rend possible

Un dépôt lit **tout** son historique, pas ses mille derniers commits. Deux
passes par tour de synchronisation :

- la **tête** (`since = le plus récent connu`) — courte, souvent vide ;
- la **queue** (`until = backfillUntil`) — le backfill, qui remonte le temps par
  tranches de `BACKFILL_PAGES` jusqu'à toucher le premier commit, puis lève
  `backfillDone` et ne recommence jamais ;
- une passe **par branche**, parce que `/commits` sans référence ne rend que la
  branche par défaut : tout ce qui ne vit que sur une branche de travail
  resterait invisible. Une branche dont la tête est déjà connue est sautée sans
  le moindre appel, ce qui rend cette passe gratuite en régime établi.

> ⚠️ La borne du backfill est mémorisée dans `sync_state` (`backfillUntil`), et
> surtout **pas** déduite d'un `MIN(committed_at)` sur le cache. Celui-ci mêle
> les commits de toutes les branches : un seul commit ancien venu d'une branche
> latérale abaisserait le minimum global, la tranche suivante repartirait de bien
> plus bas, et tout l'historique intermédiaire de la branche principale serait
> sauté sans que rien ne le signale.

Tant qu'elle n'est pas finie, le dépôt est réinscrit au tour suivant sans
attendre les dix minutes du régime ordinaire : un historique à moitié rapatrié
fait mentir le graphe sur l'âge du dépôt.

> ⚠️ **La date d'un commit est celle du _committer_, pas de l'auteur.**
>
> Ce n'est pas un détail de présentation, c'est ce qui fait converger le
> backfill. Les paramètres `since` et `until` de GitHub filtrent sur la date du
> committer ; borner les tranches sur la date d'auteur revenait à comparer deux
> grandeurs différentes, avec deux issues possibles — une borne qui ne recule
> pas, ou des commits sautés en silence. Mesuré sur un dépôt ordinaire :
> **66 commits sur 100 portent deux dates différentes** (rebase, cherry-pick, PR
> fusionnée plus tard).
>
> Corollaire : la borne `until` reçoit **une seconde de battement**. Nos
> horodatages sont arrondis à la seconde, GitHub compare à la milliseconde ;
> sans ce +1, tout commit partageant la seconde de la borne serait sauté
> définitivement, puisque le backfill ne repasse jamais. Le prix est un commit
> relu par tranche, qu'`INSERT IGNORE` absorbe.
>
> L'auteur, lui, reste l'auteur : c'est toujours `author` qui nomme et colore.

### Le graphe dessine sur un canvas

Les points étaient un `<circle>` SVG chacun. À quelques milliers de commits, le
navigateur portait autant de nœuds à mettre en page et à peindre — et **tout le
reste de l'interface ralentissait**, jusqu'au défilement de la page. Trois
changements, du plus structurant au plus fin :

1. **Un canvas** pour le nuage : un seul élément, redessiné seulement quand les
   données, la largeur ou l'auteur mis en avant changent. Les axes restent en
   SVG — une vingtaine d'éléments, du texte qui suit le thème.
2. **Une charge utile colonnaire** (`gitCommitPointsSchema`) : trois tableaux
   parallèles au lieu d'un tableau d'objets. À vingt mille commits, ~450 Ko au
   lieu de ~2 Mo, et aucune allocation d'objet côté client.
3. **Un index spatial** pour le survol : les points sont rangés en seaux par
   colonne de pixels, une recherche n'en examine que trois. Un balayage complet à
   chaque `mousemove` coûtait plus cher que le dessin.

### La légende peut réunir les auteurs sous un membre

Une même personne commite sous trois adresses selon la machine. `git.authorMap`
les rattache à un membre ; le réglage **« N'afficher que les membres rattachés »**
(dans ce même dialogue, activé par défaut) fait alors disparaître les auteurs
git au profit de la personne, qui réunit tous leurs points et tous leurs
commits.

Trois choix à connaître :

- le regroupement se fait **côté client**, dans un `useMemo` de `CommitGraph` :
  c'est une préférence de lecture, la réponse du serveur reste la même pour tout
  le monde, et la basculer ne coûte pas un aller-retour ;
- il est **local au navigateur** (`prefs.ts`, `localStorage`), pas une
  propriété de l'espace : deux personnes peuvent vouloir lire le même graphe
  différemment, et cela ne mérite ni colonne, ni migration, ni diffusion `live` ;
- **la liste du dialogue reste complète**, regroupement ou non — c'est là qu'on
  fait le rattachement, il faut donc y voir chaque auteur git séparément.

Le dialogue est atteignable **sans le droit d'écriture** : il porte un réglage
personnel. Ce sont les sélecteurs de rattachement qui s'y désactivent.

Un auteur rattaché prend la **couleur de son compte**, la même que sa présence
en direct : c'est la seule donnée d'utilisateur que la feature lit, et elle lui
vient de la façade `members.list()` (capacité `members.read`), qui rend la
couleur avec chaque membre, `null` sur un compte jamais colorié (le repli est
alors `defaultUserColor`, comme partout). Le rattachement lui-même vérifie par
la même façade que la personne est membre de l'espace du dépôt.

### L'ordre des dépôts appartient à l'utilisateur

`git_repos.sort_order` (migration 065), posé par `git.repoReorder` et par rien
d'autre ; un nouveau dépôt prend le rang suivant, donc la fin de la liste. Le
tri précédent — par date d'ajout — n'était pas un ordre mais une conséquence.

Le geste est celui d'Uptime, repris tel quel (`RepoList.tsx`) : Pointer Events
et non l'API `draggable` du HTML5, poignée dédiée en `touch-action: none`, barre
d'insertion qui se tient dans l'interstice sans déplacer aucune ligne. Les
raisons sont détaillées dans `features/uptime/src/client/ServiceList.tsx` et valent mot pour
mot ici. Un point propre à cette liste : la relecture déclenchée par
`git.list` est **retenue** pendant un glissé et rejouée au relâchement — une
liste qui se réordonne sous le pointeur n'est pas un ordre.

### Trois lectures seulement sortent du cache

`git.commitDetail` (le diff), `git.ownerCandidates` (les comptes qu'atteint un
jeton) et `git.repoCandidates` (la liste des dépôts d'un propriétaire)
interrogent GitHub **au moment de la demande** ; tout le reste vient du cache
local. Ce sont donc les trois seules dont la latence dépende d'une API tierce,
et les écrans le disent. Un diff pèse des
ordres de grandeur de plus que la ligne qui le résume, on ne le regarde qu'une
fois, et le stocker chiffré ferait grossir la base sans contrepartie. Le jeton
d'un dépôt projeté se lit **chez lui** (`ft_git_credentials` de son domicile,
sous le codec de son espace) : le chercher dans la fenêtre répondrait
« introuvable » sur un dépôt parfaitement configuré.

### Le voile de synchronisation est collant

`.gitContent` est plus haut que la fenêtre dès qu'un dépôt a quelques branches.
Un voile en `position: absolute; inset: 0` centrait donc son texte au milieu du
_contenu_ — c'est-à-dire hors écran — et débordait sous la barre de défilement.
Le voile couvre toujours toute la boîte, mais son panneau est en
`position: sticky`, calé sur le corps défilant de la popup.

---

## 6. Vérification

```bash
./ci.sh
rsync -a --delete DevEye-Types/src/ DevEye/node_modules/@deveye/types/src/
diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
```

Les tests du module (`npm run test:features`, ou
`npx tsx --test "features/git/src/**/*.test.ts"`) tournent sans base ni
réseau : les handlers sur le harnais du SDK (restrictions, projections,
contrat de Projets, idempotence, jetons), le service sur un GitHub factice
(branches, tranches de backfill, releases et `applyVersion`, 304, quota
épuisé, avancement), les décodeurs de l'adaptateur sur un `fetch` simulé.

La migration `064` a été rejouée deux fois sur une copie du dump du 5 août
(`DevEye_migtest`), avec vérification d'invariants de **données** et non
seulement de succès du DDL :

| Invariant                                                                                 | Attendu                                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| anciennes tables `project_{repos,commits,branches,releases,pull_requests,commit_authors}` | 0                                                   |
| nouvelles tables `git_*`                                                                  | 6                                                   |
| `project_repo_links` créée, `project_credentials` **conservée**                           | oui                                                 |
| mots de passe préservés                                                                   | 308                                                 |
| second démarrage                                                                          | « Migrations up to date », zéro migration rejouée   |
| démarrage                                                                                 | zéro avertissement `mutates`, aucun préfixe inconnu |

La `100` se rejoue de la même façon (`DevEye_migdry`) : `ft_git_credentials`
créée et remplie avec les identifiants d'origine, `git_repos.credential_id`
intact, `fk_git_repo_credential` absente, `workspace_credentials` disparue,
second passage sans effet.

Les cascades ont été vérifiées à la main sur cette copie : deux projets liés au
même dépôt, suppression d'un projet (dépôt et cache intacts, seconde liaison
intacte), puis suppression du dépôt (projet restant intact, liaisons et cache
partis).

### Points d'attention à l'essai manuel

1. **Idempotence** — ajouter deux fois `owner/repo` ne crée qu'un dépôt.
2. **Partage** — lier un dépôt à deux projets ; l'en-tête de chaque onglet Git
   annonce le partage, la feature Git compte les deux et les ouvre d'un clic.
3. **Jetons** — créer, modifier, supprimer ; un dépôt dont le jeton vient
   d'être retiré affiche « jeton retiré, synchronisation arrêtée » et cesse
   d'être lu (le dépôt met `credential_id` à NULL lui-même : la clé étrangère
   n'existe plus).
4. **Droits** — un rôle sans `git` : tuile désaturée, onglet Git d'un projet en
   « accès restreint », le reste du projet intact.
5. **Confidentialité** — passer un projet en confidentiel retire sa liaison ; le
   dépôt et son cache survivent dans la feature Git.
6. **Version suivie** — un projet en `github_release` prend le tag de la
   dernière release stable au tour suivant, et son champ passe en lecture seule.

---

## 7. Ce qui n'est pas fait

- **Aucun webhook** : tout est du sondage, borné par les ETags et un budget
  d'appels par tour.
- **GitLab, Gitea** : l'adaptateur GitHub est isolé dans
  `features/git/src/server/github.ts`, derrière la couture `GitHubClient` du
  service ; la surface à réimplémenter est étroite.
- **Un dépôt ne se renomme pas** : `owner/repo` **est** son identité (voir
  `slug_ref`). Viser un autre dépôt, c'est en ajouter un.
- **Le graphe porte tout l'historique**, avec une borne de sécurité à 100 000
  points pour qu'un dépôt monstrueux ne fasse pas exploser une trame WebSocket.
  Au-delà, ce sont les commits **anciens** qui sont écrêtés, et l'interface
  annonce combien de points sont affichés.

---

## 8. Le module (28 août 2026)

Git est la onzième native rapatriée sur le SDK des features
(`Docs/FEATURE_SDK.md`, « La migration des natives »). Ce que le rapatriement a
changé, en plus des chemins du §4 :

- **Les jetons GitHub ont leur table** (`ft_git_credentials`, migration `100`
  du socle : c'est le socle qui crée et copie, une migration de module ne
  pouvant pas lire ni détruire `workspace_credentials`), et leurs quatre
  gestes sont ceux du module. La table commune n'avait plus qu'un
  propriétaire : la `100` la supprime, et `_credentials.ts`,
  `db/repos/credentials.ts` et l'entrée `credentials` de `db/index.ts` sont
  partis avec elle. La clé étrangère `fk_git_repo_credential` est retirée et
  non recréée (même piège InnoDB qu'en 099) : `removeCredential` met à NULL
  les dépôts du jeton avant de retirer la ligne, ce que la contrainte faisait
  sans le dire. Le module possède la table : son `uninstall.sql` la détruit,
  les six tables historiques restent.
- **Le module ne lit aucune table de Projets.** `project_repo_links` et ses
  lectures (`listRepoIds`, `linkRepo`, `unlinkRepo`, `unlinkAllRepos`,
  `listRepoUsage`, `countRepoLinks`) sont chez Projets
  (`features/projects/src/server/repo/links.ts`, la jointure sur `git_repos`
  pour l'ordre d'affichage est admise) ; `project_count` a quitté le dépôt du
  module, `toRepo` reçoit le compte. Dans un sens, Projets demande au module
  si un dépôt existe avant de le relier (`GIT_ITEMS_PROVIDER`, publié par le
  service du module, lu par `ctx.providers` dans
  `features/projects/src/server/repoLink.ts`) ; dans l'autre, le module lit
  le contrat de Projets (`PROJECTS_USAGE_PROVIDER`, offert par l'app tant que
  Projets était native, publié par le service du module Projets depuis) pour
  le compte, la liste des projets liés, et pour
  **dire** la version d'un projet (`applyVersion`, l'ex `applyReleaseVersion`
  du service natif, désormais chez Projets : c'est lui qui connaît sa règle,
  `github_release` étant la seule source suivie aujourd'hui).
- **`IntegrationSyncService` n'existe plus.** Sa moitié déploiement était
  partie le matin même dans `DeploySync` ; sa moitié git est `GitSync`
  (`service.ts`), sur `FeatureServiceDeps` : un ticker du SDK à deux minutes,
  `cipherFor` mémoïsé par le SDK, `live.changed(ws)` à chaque tour qui a
  changé quelque chose, et une couture de test (`{ github }`, les six lectures
  de l'adaptateur). Les handlers atteignent le service par le singleton du
  module (`setSync` / `syncOf`, patron `setEngine` de CloudSync), tolérant à
  son absence comme l'était `ctx.integrations?.` ; `ctx.integrations` a quitté
  `FeatureContext`, `WSDeps` et `app.ts`.
- **La façade `members` rend la couleur d'un compte.** Le graphe colorait un
  auteur rattaché de la couleur de son compte en lisant la table `users` ; un
  module n'y a pas accès, et la couleur d'une personne est une donnée que tout
  écran qui la montre doit pouvoir lire. `members.list()` porte donc `color`
  (`null` sur un compte jamais colorié), et Git déclare `members.read`, seule
  capacité du manifest (le rattachement d'un auteur vérifie l'appartenance par
  la même liste).
- **Ce que le SDK n'offrait pas alors**, comme pour Bases de données et
  Déploiement : un `mutates` multi-sujets (`git.repoRemove` déclarait
  `['git', 'projects']`) et un `live.changed` sur le sujet `projects` (le
  service natif le nommait après un tour qui a pu changer la version d'un
  projet). Depuis le rapatriement de Projets, le SDK admet les deux, et c'est
  Projets qui ravive `projects` quand `applyVersion` a changé une version ;
  l'onglet d'un projet suit `git.repo` et voit le cache changer, ses compteurs
  d'onglets se relisent à leur prochaine lecture.
