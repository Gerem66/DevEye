# Git — les dépôts d'un espace

> Écrit le 7 août 2026, à la fin du chantier qui a sorti le git du module
> Projets ; relu et mis à jour le 21 août 2026 (sources, coquille de réglages).
> Compagnon de [PROJECTS.md](./PROJECTS.md) : celui-ci suit le travail,
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
   > Elles sont parties dans la feature Déploiement ([DEPLOY.md](./DEPLOY.md)),
   > qui n'existait pas encore à l'époque. La table reste commune, le panneau
   > aussi (`CredentialsPanel`, l'onglet Sources de la coquille de réglages,
   > voir `SOURCES.md`) ; seuls la porte et le droit se sont séparés —
   > poser la clé qui met en production ne relève pas du droit de lire des
   > dépôts.
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
la clé de l'espace, à l'étage ouvert, une fois pour toutes.

Trois conséquences, toutes bonnes :

- la feature Git ne demande **jamais** de mot de passe ;
- le service de fond, qui tourne sans session, lit tout ce dont il a besoin ;
- la course qui obligeait l'ancien `markSynced` à porter une garde atomique sur
  `projects.security_tier` — le projet basculant en confidentiel entre la
  sélection d'un dépôt et l'écriture de son résultat — **a disparu avec sa
  cause**, pas avec sa garde.

Corollaire assumé : **un projet confidentiel n'a pas de dépôt.**
`project.repoLink` le refuse, et passer un projet en confidentiel retire sa
liaison (`projectSetSecurityTierFeature`). Ce n'est pas seulement que la
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
dépôt — et une clé sur `project_id` seul faisait *remplacer* là où l'on voulait
*ajouter*.

Les trois liaisons d'un projet ont désormais la même forme — dépôts (069),
services surveillés (067), bases de données (068) — et c'est la forme juste :
ce sont des objets d'espace, pas des propriétés d'un projet.

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
d'ajout. Voir [PROJECTS.md](./PROJECTS.md) §2.

---

## 3. Ce que ça donne à l'usage

| Vue | Contenu |
|---|---|
| **Dépôts** | tous les dépôts de l'espace, dernière synchro, nombre de projets, cause d'un blocage |
| **Un dépôt** | graphe des commits, branches, releases, pull requests, derniers commits, projets liés |
| **Réglages → Sources** | les jetons GitHub de l'espace, ajout / modification / suppression, avec ce que chacun sert : l'ancien bouton « Jetons GitHub », absorbé par la coquille commune. Le « + » du sélecteur de jeton (RepoPicker / RepoDialog) y mène, et le dépôt adopte le jeton créé au retour |
| **Réglages d'un dépôt** | partage entre espaces et permissions par rôle (`SETTINGS.md`, `SHARING.md`) |
| **Onglet Git d'un projet** | le même dépôt, vu depuis le projet |

Les deux derniers écrans sont **le même composant** (`Features/Git/RepoView`).
Un dépôt n'a pas à se présenter autrement selon la porte par laquelle on entre,
et une seconde implémentation aurait divergé au premier ajustement.

L'interconnexion va dans les deux sens : depuis un projet on atteint son dépôt,
et depuis un dépôt on ouvre en un clic chacun des projets qui l'utilisent.

---

## 4. Carte du code

### Contrats — `DevEye-Types/src/`

```
domain/git.ts      dépôt, jeton, branches, commits, releases, PR, diff, sync
features/git.ts    toutes les commandes (préfixe unique `git.`)
```

`features/project.ts` n'en garde que trois : `project.repoList` / `repoLink` /
`repoUnlink`. Elles ne manipulent qu'un `repoId`.

### Serveur — `DevEye/src/`

```
db/migrations/064_git_repos.sql      table rase de l'ancien schéma, 7 tables
db/repos/git.ts                      dépôts, jetons, liaisons, cache
features/git/{_shared,repo,credentials,read}.ts
features/project/repoLink.ts         la liaison, et rien d'autre
Services/IntegrationSyncService.ts   ordonnanceur (dépôts + déploiements)
Services/integrations/{github,dokploy}.ts
```

### Client — `DevEye/client/src/Features/Git/`

```
index.tsx             liste des dépôts ; possède le niveau live `l1`
RepoList.tsx          les cartes + le glisser-déposer d'ordonnancement
RepoDetail.tsx        en-tête d'un dépôt + RepoView + projets liés
RepoView.tsx          ⟵ le cœur partagé avec l'onglet Git d'un projet
Rows.tsx              lignes de branche / release / PR / commit, partagées
ListDialog.tsx        le « voir tout » d'un panneau
AuthorMapDialog.tsx   rattachement des auteurs aux membres + regroupement
RepoDialog.tsx        ajouter / modifier / supprimer un dépôt (le « + » du
                      jeton ouvre Réglages → Sources ; le panneau des jetons
                      est Components/FeatureSettings/sections/CredentialsPanel)
RepoPicker.tsx        jeton → propriétaire → dépôt, partagé avec les Projets
prefs.ts              préférences d'affichage, locales au navigateur
CommitGraph.tsx  CommitDialog.tsx  PullRequestDialog.tsx  GitWidget.tsx
```

`Features/Projects/Git/` se réduit à `Git.tsx` (enveloppe mince) et
`LinkRepoDialog.tsx` (choisir un dépôt existant, ou en créer un).

---

## 5. Pièges, et pourquoi ils existent

### Le filet de démarrage ne couvre pas ce module

`MUTATION_VERB` (`src/features/_topics.ts`) cherche un verbe **juste après le
point** (`note.add`). Les commandes d'ici sont en camelCase sous un préfixe
unique (`git.repoAdd`) : **il n'en verra aucune**, exactement comme pour les
projets. Un `mutates` oublié ne produira donc aucun avertissement.

→ **Relire `mutates` à la main** sur chaque écriture ajoutée. En revanche, un
préfixe absent de `COMMAND_PREFIX_TOPIC` **fait échouer le démarrage** — c'est
un contrat, pas une heuristique.

### Une seule liste de rekey, désormais

Le cache git ne figure **plus** dans `projectRekey.ts` : il n'a plus de tier de
projet à suivre. Il relève de `workspaceRekey.ts` et de lui seul, à l'étage
ouvert. Toute nouvelle colonne chiffrée pendue à `git_repos` doit y être
inscrite — rien ne peut le détecter, un blob chiffré est indistinguable d'un
autre.

`sync_state` et `last_sync_error` y sont volontairement absents : éphémères,
réécrits en permanence par le service de fond. Un ETag illisible ne fait rien de
pire qu'un 200 au lieu d'un 304.

### Le droit `git` est distinct de `projects`

Lire le dépôt d'un projet relève de `git: read`, pas de `projects`. L'onglet Git
d'un projet le dit explicitement quand le rôle ne l'accorde pas, plutôt que
d'afficher un écran vide qui se lirait comme un bug.

⚠️ **Les rôles existants n'accordent pas `git`** — *fail-closed*, voir
WORKSPACES.md §3. Le propriétaire a tout d'office ; les autres membres doivent
recevoir le droit dans « Gérer l'espace › Rôles ».

### La progression se sonde, elle ne se diffuse pas

Les six étapes d'un tour feraient re-solliciter tout l'écran six fois d'affilée
chez **tous** les membres de l'espace, pour une information qui n'intéresse que
celui qui a pressé le bouton. D'où `git.repoSyncStatus`, sondée toutes les
700 ms par la seule vue concernée, et une unique invalidation à la fin.
`git.syncStatuses` fait la même chose pour la liste, en un seul appel — les deux
ne lisent qu'une table **en mémoire** du service, sans requête ni déchiffrement,
et c'est ce qui rend le sondage défendable.

Corollaire assumé, vrai de tout le direct : derrière deux instances, seule celle
qui synchronise connaît l'avancement.

**Le sondage n'a aucune limite de durée, et c'est délibéré.** Il en avait une —
trois minutes — et elle était fausse : relire un dépôt de plusieurs milliers de
commits prend plus longtemps, et la barre disparaissait en plein travail. Le
serveur est la seule autorité sur « c'est fini » ; il retire l'entrée
d'avancement dans un `finally`, échec compris, donc la boucle s'arrête toujours.

Deux corollaires côté serveur, dans `IntegrationSyncService.syncOne` :

- entre deux tranches de rapatriement d'historique, l'entrée d'avancement
  **survit** aux trois secondes de répit — sans quoi l'interface concluait
  « terminé » au milieu d'un travail qui allait durer des minutes ;
- la tranche suivante est enchaînée par un **appel direct** à `syncOne`, et non
  par `forced` + `tick()` : le dépôt vient d'être synchronisé, il trie donc en
  dernier dans `listDue`, et un tour déjà en cours aurait avalé la relance. Une
  tranche perdue laisserait l'historique incomplet **et** une barre figée.

### Désigner un dépôt : l'ordre des champs est le sujet

`RepoPicker` pose **jeton → propriétaire → dépôt**, dans cet ordre, parce que le
jeton *change le résultat* des deux autres : sans lui GitHub ne rend que le
public, avec lui il rend aussi les dépôts privés du compte ou de l'organisation.
Le placer sous la liste revenait à demander de choisir avant d'avoir dit ce que
la liste devait contenir. La liste se recharge donc à chaque changement de l'un
ou de l'autre, et d'eux seuls.

`listOwnerRepos` essaie trois chemins, parce que GitHub n'expose pas la même
chose selon qui demande :

1. **`/user/repos`** quand le jeton appartient au propriétaire demandé — le
   **seul** endpoint qui rende ses dépôts privés. `/users/{login}/repos` ne rend
   que le public *même avec le jeton de l'intéressé* : c'est le piège de cette
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

> ⚠️ **La date d'un commit est celle du *committer*, pas de l'auteur.**
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
- il est **local au navigateur** (`Features/Git/prefs.ts`, `localStorage`), pas
  une propriété de l'espace : deux personnes peuvent vouloir lire le même graphe
  différemment, et cela ne mérite ni colonne, ni migration, ni diffusion `live` ;
- **la liste du dialogue reste complète**, regroupement ou non — c'est là qu'on
  fait le rattachement, il faut donc y voir chaque auteur git séparément.

Le dialogue est atteignable **sans le droit d'écriture** : il porte un réglage
personnel. Ce sont les sélecteurs de rattachement qui s'y désactivent.

### L'ordre des dépôts appartient à l'utilisateur

`git_repos.sort_order` (migration 065), posé par `git.repoReorder` et par rien
d'autre ; un nouveau dépôt prend le rang suivant, donc la fin de la liste. Le
tri précédent — par date d'ajout — n'était pas un ordre mais une conséquence.

Le geste est celui d'Uptime, repris tel quel (`RepoList.tsx`) : Pointer Events
et non l'API `draggable` du HTML5, poignée dédiée en `touch-action: none`, barre
d'insertion qui se tient dans l'interstice sans déplacer aucune ligne. Les
raisons sont détaillées dans `Features/Uptime/ServiceList.tsx` et valent mot pour
mot ici. Un point propre à cette liste : la relecture déclenchée par
`git.list` est **retenue** pendant un glissé et rejouée au relâchement — une
liste qui se réordonne sous le pointeur n'est pas un ordre.

### Deux lectures seulement sortent du cache

`git.commitDetail` (le diff) et `git.repoCandidates` (la liste des dépôts d'un
propriétaire) interrogent GitHub **au moment de la demande** ; tout le reste
vient du cache local. Ce sont donc les deux seules dont la latence dépende d'une
API tierce, et les écrans le disent. Un diff pèse des
ordres de grandeur de plus que la ligne qui le résume, on ne le regarde qu'une
fois, et le stocker chiffré ferait grossir la base sans contrepartie.

### Le voile de synchronisation est collant

`.gitContent` est plus haut que la fenêtre dès qu'un dépôt a quelques branches.
Un voile en `position: absolute; inset: 0` centrait donc son texte au milieu du
*contenu* — c'est-à-dire hors écran — et débordait sous la barre de défilement.
Le voile couvre toujours toute la boîte, mais son panneau est en
`position: sticky`, calé sur le corps défilant de la popup.

---

## 6. Vérification

```bash
./ci.sh
rsync -a --delete DevEye-Types/src/ DevEye/node_modules/deveye-types/src/
diff -rq DevEye-Types/src DevEye/node_modules/deveye-types/src   # doit être vide
```

Il n'existe aucun framework de test dans ce dépôt. La migration `064` a été
rejouée deux fois sur une copie du dump du 5 août (`DevEye_migtest`), avec
vérification d'invariants de **données** et non seulement de succès du DDL :

| Invariant | Attendu |
|---|---|
| anciennes tables `project_{repos,commits,branches,releases,pull_requests,commit_authors}` | 0 |
| nouvelles tables `git_*` | 6 |
| `project_repo_links` créée, `project_credentials` **conservée** | oui |
| mots de passe préservés | 308 |
| second démarrage | « Migrations up to date », zéro migration rejouée |
| démarrage | zéro avertissement `mutates`, aucun préfixe inconnu |

Les cascades ont été vérifiées à la main sur cette copie : deux projets liés au
même dépôt, suppression d'un projet (dépôt et cache intacts, seconde liaison
intacte), puis suppression du dépôt (projet restant intact, liaisons et cache
partis).

### Points d'attention à l'essai manuel

1. **Idempotence** — ajouter deux fois `owner/repo` ne crée qu'un dépôt.
2. **Partage** — lier un dépôt à deux projets ; l'en-tête de chaque onglet Git
   annonce le partage, la feature Git compte les deux et les ouvre d'un clic.
3. **Jetons** — créer, modifier, supprimer, pour les deux fournisseurs ; un
   dépôt dont le jeton vient d'être retiré affiche « jeton retiré,
   synchronisation arrêtée » et cesse d'être lu.
4. **Droits** — un rôle sans `git` : tuile désaturée, onglet Git d'un projet en
   « accès restreint », le reste du projet intact.
5. **Confidentialité** — passer un projet en confidentiel retire sa liaison ; le
   dépôt et son cache survivent dans la feature Git.

---

## 7. Ce qui n'est pas fait

- **Aucun webhook** : tout est du sondage, borné par les ETags et un budget
  d'appels par tour.
- **GitLab, Gitea** : l'adaptateur GitHub est isolé dans
  `Services/integrations/`, la surface à réimplémenter est étroite.
- **Un dépôt ne se renomme pas** : `owner/repo` **est** son identité (voir
  `slug_ref`). Viser un autre dépôt, c'est en ajouter un.
- **Le graphe porte tout l'historique**, avec une borne de sécurité à 100 000
  points pour qu'un dépôt monstrueux ne fasse pas exploser une trame WebSocket.
  Au-delà, ce sont les commits **anciens** qui sont écrêtés, et l'interface
  annonce combien de points sont affichés.
