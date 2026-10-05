# Déploiements : les mises en production d'un espace

Déploiements déclare des cibles (une application ou une pile compose d'une
instance Dokploy, un workflow GitHub Actions, un service compose d'une machine
enrôlée), les déclenche et suit leur état, celui des déploiements partis
d'ailleurs compris. DevEye déclenche et observe, rien de plus : domaine,
variables d'environnement et build vivent chez le fournisseur. Compagnon de
[Projets](../projects/README.md) et jumeau de [Git](../git/README.md).

---

## 1. Le modèle

### Une cible est une entité de l'espace

Une cible appartient à l'espace (`deploy_targets`), avec son accès, son
historique et son suivi. Un projet n'en garde qu'une **liaison** : une ligne
dans `project_deploy_links`, une table de Projets, et rien d'autre. Une pile
compose sert souvent deux projets (un client et un serveur qui partent
ensemble), et une application qu'on veut seulement suivre n'a pas besoin de
projet.

> **Supprimer l'un ne supprime jamais l'autre.** Délier une cible d'un projet
> laisse la cible, son historique et les autres projets qui la déploient.
> Supprimer une cible laisse les projets, qui perdent seulement leur pointeur.
> Ce que vise la cible chez son fournisseur n'est jamais touché : DevEye ne fait
> que le pointer.

### Tout est à l'étage ouvert

Une cible appartient à l'espace, pas à un projet : elle ne peut suivre le
`security_tier` d'aucun d'eux. Cible et historique sont chiffrés sous la clé de
l'espace, à l'étage ouvert. La feature ne demande **jamais** de mot de passe, et
le suivi de fond, qui tourne sans session, lit tout ce dont il a besoin.

Corollaire : **un projet confidentiel n'a pas de déploiement.**
`projects.deployLink` le refuse, et passer un projet en confidentiel retire ses
liaisons, avec un événement de frise.

### Le droit de déployer est un droit à part

`deploy` est une feature distincte de `projects` et de `git`, avec son `read` et
son `write`. **C'est le seul droit de DevEye qui produise un effet hors de
DevEye** : `deploy: write` autorise à poser la clé d'une instance et à pousser
en production, ce que lire des dépôts ou tenir un tableau de tâches n'implique
pas. `deploy.trigger` est auditée au niveau `warning` pour cette raison.

D'où deux tables de jetons, `ft_deploy_credentials` et `ft_git_credentials`
(module Git) : aucune des deux portes ne peut servir le jeton de l'autre. **Le
jeton GitHub de Déploiements n'est pas celui de Git** : Git lit des dépôts
(Contents en lecture), Déploiements lance des workflows (Actions en écriture).
Partager le jeton donnerait à `git: write` le pouvoir de déployer.

Il n'y a pas de clé étrangère de `deploy_targets` vers `ft_deploy_credentials` :
`removeCredential` met à NULL le `credential_id` des cibles de l'accès, puis
retire la ligne. Une cible sans accès reste, se peint en danger, annonce « accès
retiré » et refuse de se déclencher.

### Une cible se déclare, elle ne se crée pas

Elle existe déjà chez son fournisseur. Le dialogue interroge l'accès **dès qu'on
en désigne un** et propose ce qu'il publie (`deploy.candidates`), avec un repli
manuel pour une forme de réponse que le décodeur ne reconnaîtrait pas.

`deploy.add` est **idempotente** sur (accès, identifiant externe), ou (machine,
identifiant externe) pour une cible portée par une machine : déclarer deux fois
la même application la retrouve et met son intitulé à jour, ce qui permet à un
projet de la déclarer sans savoir si un autre l'a déjà fait. Un accès ne change
jamais de fournisseur, et une cible ne désigne qu'un accès du sien
(`deploy.update` le vérifie).

`deploy.trigger` accepte un `projectId` **facultatif** : déclenché depuis
l'onglet d'un projet, le fait entre dans sa frise ; déclenché depuis la feature,
il n'appartient à aucun projet, et l'attribuer à l'un d'eux au hasard serait
faux.

### Quatre états, trois fournisseurs

Un déploiement est `queued`, `running`, `success` ou `failed` : chaque
adaptateur y projette le vocabulaire de son fournisseur. Les fournisseurs
(§3.4) :

|                   | Dokploy                                                              | GitHub Actions                                                                | Une machine                                                                |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Accès             | adresse de l'instance + clé d'API, par le serveur ou par un appareil | jeton à grain fin, sans adresse                                               | aucun : une machine de l'espace, et la permission Docker de qui la déclare |
| Cible             | application ou pile compose (`target_kind`)                          | workflow d'un dépôt sur une branche (`propriétaire/dépôt#id`)                 | service compose (`moteur/projet/service`)                                  |
| Déclencher        | `application.deploy` / `compose.deploy`                              | `workflow_dispatch` ; un workflow sans ce déclencheur est refusé, raison dite | `docker.action` `composeDeploy`, signé : `pull` puis `up --no-deps`        |
| Historique        | `deployment.all` / `deployment.allByCompose`                         | les exécutions du workflow sur la branche, un 304 ne coûte rien               | le nôtre : rien n'est sondé                                                |
| Rattachement      | par identifiant, sinon par date                                      | par date : l'API ne rend pas l'exécution qu'elle crée                         | direct : la ligne attend son verdict                                       |
| Journal de l'avis | la queue du journal (WebSocket)                                      | les étapes des jobs : faites, en cours, à venir                               | les lignes de l'agent, au fil de l'action                                  |
| Journal complet   | le même flux, lu jusqu'au silence                                    | le texte de chaque job, par une redirection que le jeton ne suit pas          | les 64 derniers Kio, gardés avec le déploiement                            |
| Limite de débit   | aucune                                                               | compteur épuisé : l'accès recule jusqu'à `x-ratelimit-reset`                  | une action longue à la fois par machine, verrou partagé avec Appareils     |
| Offre             | compte dans `deploy.targets`                                         | compte dans `deploy.targets`                                                  | hors `deploy.targets` : rien n'est sondé, les machines ont leur limite     |

---

## 2. À l'usage

| Vue                                 | Contenu                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cibles**                          | toutes les cibles de l'espace, état du dernier déploiement, nombre de projets, lien perdu avec l'instance, rangeables au glisser-déposer                                                                                                                             |
| **Fiche**                           | l'en-tête de la cible (retour, titre, actions, dont le bouton de réglages commun), « Déployer », l'historique tel que le fournisseur le rend et le journal de chacun                                                                                                 |
| **Réglages → Sources**              | les accès de l'espace : une instance Dokploy (adresse + clé d'API, jointe en « Direct » ou « Par un appareil ») ou un jeton GitHub, avec ce que chacun dessert ([`Docs/SOURCES.md`](../../Docs/SOURCES.md))                                                          |
| **Réglages → Notifications**        | les canaux de la feature ([`Docs/NOTIFICATIONS.md`](../../Docs/NOTIFICATIONS.md))                                                                                                                                                                                    |
| **Réglages d'une cible**            | Général (accès, cible visée, type ou branche, intitulé, suppression), Notifications (les canaux que **cette** cible coche), Partage entre espaces et Permissions par rôle ([`Docs/SETTINGS.md`](../../Docs/SETTINGS.md), [`Docs/SHARING.md`](../../Docs/SHARING.md)) |
| **Onglet Déploiements d'un projet** | les cibles reliées : une vue sur cette feature, composée par Projets                                                                                                                                                                                                 |

La fiche d'une cible et l'onglet d'un projet sont le même composant
(`TargetView`, composé par l'onglet à travers `DEPLOY_CLIENT_PROVIDER`), et
suivent tous deux `deploy.detail` : ils montrent le même état, sans recharger.

La tuile d'accueil compte les cibles de l'espace (`deploy.count`), pas l'état du
dernier déploiement : ce serait la seule tuile à changer sans qu'on ait rien
fait. Sans le droit `deploy`, la tuile reste à sa place, à demi-opacité, et
affiche « Accès restreint » à la place de son contenu ; l'onglet d'un projet dit
que le rôle n'ouvre pas les cibles qu'il déploie.

---

## 3. Comment ça marche

### 3.1 Les commandes

Dix-sept commandes sous le préfixe `deploy.`, en camelCase
(`src/contracts/commands.ts`) :

- **cibles** : `list`, `count`, `get`, `add`, `update`, `remove`, `reorder`,
  `candidates`, `machines` ;
- **déploiements** : `trigger`, `history`, `log` ;
- **accès** : `credentialList`, `credentialAdd`, `credentialUpdate`,
  `credentialRemove`, `credentialDevices`.

Toute commande qui prend un `targetId` commence par `loadTarget` : la cible doit
être visible de l'espace actif (chez elle, ou projetée ici), et
`ctx.items.assert` refuse ce qu'une restriction de rôle masque ou passe en
lecture seule. `loadHomeTarget` exige en outre que la cible soit chez
l'appelant : la modifier et la supprimer se font au domicile ; une fenêtre lit,
déclenche et suit, et tout ce qui s'écrit alors (la ligne, sa clé, son suivi)
appartient au domicile.

`deploy.trigger` écrit sa ligne **avant** d'appeler le fournisseur : si celui-ci
accepte puis que la réponse se perd, il reste une trace de ce qui a été
déclenché. Un refus passe la ligne en `failed` avec le message du fournisseur,
puis remonte. Le suivi de fond est ensuite réveillé (`wakeSync`) plutôt
qu'attendu à sa cadence.

`deploy.history` interroge le fournisseur à chaque appel : réservée à la fiche,
jamais à une liste. `deploy.log` retrouve la référence du journal dans
l'historique que le client vient de lister (`historyCache.ts`, cinq minutes par
cible, deux cents cibles au plus) : chez Dokploy, c'est un emplacement sur le
disque du fournisseur, rien à exposer au client ; le fournisseur n'est
réinterrogé qu'au raté.

Le filet de démarrage (`MUTATION_VERB` dans `src/features/_topics.ts`) cherche un
verbe juste après le point et ne reconnaît aucune commande en camelCase : un
`mutates` oublié ne produit aucun avertissement, et se relit à la main sur
chaque écriture.

### 3.2 Le rapprochement de fond (`DeploySync`)

Aucun fournisseur ne prévient DevEye de lui-même : Dokploy n'émet pas de webhook
de forme générique (ses notifications sont mises en page pour Discord, Slack ou
Telegram) et un webhook GitHub demanderait une route publique et un secret par
dépôt, là qu'un sondage avec ETag ne coûte rien à un workflow qui ne bouge pas.
L'état est donc **sondé**, cible par cible, par `src/server/service.ts` : ce que
le fournisseur connaît entre en base, y compris un déploiement parti de
l'interface de Dokploy, d'une CI ou d'un push git. La liste dit la vérité du
dernier état connu même sans réseau vers l'instance, et une cible déployée par
une CI a une frise complète sans que personne n'ait ouvert sa fiche. Chaque
changement diffuse sur le sujet `deploy`.

| Constante                     | Valeur                          | Ce qu'elle empêche                                                                 |
| ----------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `DEPLOY_TICK_SECONDS`         | 10 s                            | la cadence du tour, donc celle du message de suivi (§3.3)                          |
| `DEPLOY_CONCURRENCY`          | 16 cibles en vol, une par accès | quarante cibles en quarante requêtes d'un coup, une instance lente en tête de file |
| `DEPLOY_SYNC_TIMEOUT_MS`      | 10 s par lecture de fond        | une instance muette qui garde sa place en vol                                      |
| `DEPLOY_MIN_INTERVAL_SECONDS` | 60 s au repos                   | réinterroger une cible qui n'a rien à dire                                         |
| `DEPLOY_BACKOFF_MAX_SECONDS`  | 15 min                          | marteler une instance en panne                                                     |
| `DEPLOY_LINK_LOST_FAILURES`   | 3 échecs consécutifs            | crier au lien perdu sur un seul raté                                               |
| `DEPLOY_LOG_TIMEOUT_MS`       | 3 s                             | une lecture de journal qui dépasserait le tour (§3.3)                              |
| `DEPLOY_IMPORT_LIMIT`         | 20 lignes par appel             | recopier des centaines d'entrées anciennes                                         |
| `DEPLOY_MATCH_WINDOW_SECONDS` | 120 s                           | rattacher par la date deux déploiements distincts                                  |
| `DEPLOY_STALE_SECONDS`        | 6 h                             | entretenir sans fin un déploiement que le fournisseur a oublié                     |

Une cible qui a un déploiement **en vol** échappe à l'intervalle au repos et
passe à chaque tour : c'est là que l'état bouge à la dizaine de secondes.

`listTargetsDue` trie en SQL et sert les espaces **à tour de rôle**
(`ROW_NUMBER() OVER (PARTITION BY workspace_id …)`) : la première cible due de
chaque espace passe avant la deuxième de quiconque. Un tour lance les cibles
choisies sans les attendre ; le tour suivant reprend ce qui s'est libéré. Une
cible en vol n'est pas relancée, et un accès n'a jamais qu'une cible en vol : une
instance lente n'occupe qu'une place et ne retarde jamais les cibles d'une autre.
Les cibles sans accès, celles d'un accès Dokploy sans adresse et celles que
l'offre tient en pause sont écartées dans la requête. `DeploySync.wake()`,
appelé par `deploy.trigger`, déclenche un tour hors cadence ; une garde de
ré-entrance rend l'appel inoffensif s'il en tourne déjà un. `idle()` attend tout
ce qui est en vol (l'arrêt du service s'en sert, les tests aussi).

**Le recul se compte par accès, en mémoire**, jamais dans `synced_at` : 60 s au
premier échec, doublé ensuite jusqu'à 15 min, remis à zéro au premier succès ;
un fournisseur qui dit quand revenir (limite de débit, `retryAt`) est écouté.
Exception : le relais d'un appareil qui ne s'ouvre pas (hors ligne, droit perdu)
se constate sans rien envoyer, donc sans doublement, toutes les minutes ; l'agent
qui revient est vu à la minute. Les cibles d'un accès en recul sont écartées dès
la requête : une instance en panne ne tient plus la tête de file avec ses
déploiements « en cours ». Ceux-ci passent quand même en suivi perdu à la borne
des six heures.

**Le lien perdu se dit.** Au troisième échec consécutif d'un accès, la ligne de
l'accès garde la date et la cause (`unreachable_since`, `unreachable_error`),
l'écran le montre (Sources, carte et fiche des cibles), et **un seul** avis
« Lien perdu avec l'instance de « accès » » part : dix cibles sur la même
instance tombent ensemble, et dix messages diraient une seule chose. Il va aux
canaux cochés par les cibles de l'accès, chacun une fois (`notify.send(alert, {
itemIds })`, l'union de leurs routes) : qui suit une cible apprend que son
instance est tombée, sans rien régler de plus. L'avis nomme les cibles qui en
dépendent (les cinq premières, le reste compté). Ne comptent que les échecs qui
visent l'instance : le garde, le réseau ou le relais d'un appareil (statut 0),
une clé refusée (401, 403). Une limite de débit dit quand revenir, un 404 ou un
500 parle d'une cible : ni l'un ni l'autre ne sont un lien perdu. Au premier
succès suivant, la ligne s'efface et le retour se dit, mais seulement si un canal
avait accepté la perte (`unreachable_notified`) : jamais un « rétabli » sans
« perdu ». L'état étant en base, un redémarrage ne répète pas la perte et
n'oublie pas le retour.

**`synced_at` porte deux rôles.** Il ordonne les cibles à réinterroger, **et**
son `NULL` distingue le premier rapprochement des suivants. C'est ce qui empêche
l'import initial de notifier : la première fois, tout l'historique d'une cible
est « nouveau » sans que rien ne vienne de se produire. D'où le corollaire : un
rapprochement qui échoue ne l'horodate pas, sinon le suivant prendrait tout
l'historique pour du neuf. Le premier import tait le **passé**, pas le présent :
une pile en cours de déploiement à cet instant-là entre en base non annoncée, et
son avis part quand elle atterrit. `deployments.notified` complète le
dispositif : un avis appartient au **déploiement**, pas au tour qui l'a vu, si
bien qu'un déploiement terminé pendant que le serveur était arrêté a son avis au
redémarrage, et ne l'a qu'une fois.

**Le rattachement.** Une entrée du fournisseur retrouve sa ligne locale par
`external_id`, sinon par proximité de date (deux minutes) : Dokploy ne rend pas
toujours d'identifiant au déclenchement, GitHub jamais, et `deploy.trigger`
écrit sa ligne avant d'appeler. La date est réservée aux lignes qui n'ont pas
encore d'identifiant, sans quoi deux déploiements partis à quelques secondes
d'intervalle se colleraient sur la même ligne ; un `Set` de lignes déjà
appariées interdit qu'une même serve deux fois dans le tour. Une ligne locale que
le fournisseur ne reconnaît jamais passe, au bout de six heures, en **suivi
perdu** : `failed` avec une description qui le dit, et **sans avis**, parce
qu'annoncer un échec qu'on n'a pas constaté serait pire que de se taire. La
borne vaut aussi quand l'instance ne répond plus du tout, et la description le
dit alors.

**Les déploiements par une machine** ne sont pas sondés : `startAgentDeploy`
suit l'action par `agents.dockerRun`, recueille les lignes de l'agent (les
64 derniers Kio sont gardés), tient le message vivant au même rythme qu'une
cible sondée et enregistre le verdict. Au démarrage, `recover()` passe en échec,
sans avis, ceux restés en vol : leur attente vivait dans le processus précédent,
plus personne n'en recevra le verdict.

### 3.3 Les avis et le message qui suit le déploiement

Un avis part à l'**atterrissage**, échec comme succès, y compris pour un
déploiement lancé ailleurs. Il n'y a pas de « retour à la normale » :
contrairement à Uptime, un déploiement est un fait ponctuel, pas un état
continu ; la mise en production suivante le dira. Les canaux appartiennent à la
feature (Réglages → Notifications), et chaque cible coche les siens dans ses
propres réglages : une cible sans canal coché ne prévient personne, il n'y a pas
d'héritage. Le module appelle la façade `notify` du SDK (`send(alert, { itemId,
except })`) et ne voit ni les canaux ni leur résolution. L'avis en texte (mail,
Slack, point d'entrée maison) dit la cible, l'état, les dates et la durée, puis
la description du fournisseur, seule ligne qui dise pourquoi ; ses horodatages
sont ceux de l'app (`formatMoment`, `formatDuration` de `Services/alertCore`),
pour qu'un avis de déploiement ne semble pas venir d'un autre produit qu'une
alerte de disponibilité.

**Sur Discord, un seul message suit le déploiement du début à la fin.** Discord
est le seul canal qui sache modifier un message envoyé : `POST
/api/webhooks/{id}/{token}?wait=true` rend le message créé, donc son
identifiant, et `PATCH /api/webhooks/{id}/{token}/messages/{id}` le modifie,
sans limite de durée. Aucun bot, aucun jeton d'application : l'URL de webhook
suffit. Le module passe par trois appels de la façade : `liveChannels({ itemId
})` rend les canaux de la route de la cible capables de porter un message vivant
(Discord) ; `postLive(channelId, message, messageId?)` publie sans identifiant,
modifie avec, et rend l'identifiant à garder, ou `null` quand le canal refuse
(message supprimé à la main, webhook révoqué : on s'arrête là sans republier) ;
`send(alert, { itemId, except })` livre l'avis en texte en sautant les canaux
dont le message vivant a conclu, sans quoi Discord recevrait le message modifié
**et** un second message en clair juste en dessous. Le mail, lui, est toujours
servi : il ne sait pas se modifier. Un canal d'un autre type garde son message
unique à l'atterrissage.

Un déploiement découvert **en vol** ouvre le message ; les tours suivants le
**modifient** (barre, temps écoulé, queue du journal) jusqu'à la conclusion, qui
remplace le tout par l'issue, la durée et l'erreur s'il y en a une. Un
déploiement **trop court pour être vu en vol** reçoit exactement le même message,
publié une seule fois : une fiche complète pour un déploiement d'une minute et
trois lignes de texte pour celui d'à côté, sans que rien n'explique la
différence, ne serait pas lisible. Les identifiants des messages vivent dans le
blob chiffré de la ligne (`StoredDeployment.noticeIds`, un par canal) et sont
**persistés** : un serveur redémarré au milieu d'un déploiement reprend les
messages qu'il avait ouverts au lieu d'en poser de seconds. Passé
`DEPLOY_STALE_SECONDS`, le message cesse d'être entretenu.

La forme (`src/server/notice.ts`) suit celle des avis que Dokploy envoie
lui-même, pour qu'on n'ait pas à réapprendre à lire un message reçu dans le même
salon : trois colonnes (**projet, service, environnement**), puis type, date,
durée, puis le lien vers la fiche et celui vers le dépôt, côte à côte quand ils
sont deux. Le temps occupe **la même case** dans les deux états (« Écoulé »
pendant, « Durée » après) : c'est le même message qui se transforme. La durée
affichée est celle du fournisseur (`finishedAt - startedAt`), jamais une mesure
de DevEye. L'intitulé est réduit à la **première ligne** du message de commit
(cent caractères) : Dokploy y range le message entier. Les séquences ANSI de la
sortie de build sont retirées, un bloc de code Discord les rendant telles
quelles.

**Le journal est un champ, pas un morceau de la description** : Discord rend
toujours les `fields` après la `description`, et tant que le journal vivait dans
la seconde, projet, service et durée se retrouvaient sous dix lignes de build.
Le prix est un plafond de 1 024 caractères par champ, contre 4 096 pour une
description : les lignes sont retirées **par le haut**, les plus anciennes,
jusqu'à tenir, plutôt que de laisser Discord rejeter le message entier. Huit
lignes au plus, coupées à 110 caractères.

**La barre est une estimation, et le dit.** Aucun fournisseur ne publie de
progression (Dokploy rend statut, dates, message d'erreur et chemin du journal ;
GitHub, des étapes). La barre est calculée sur la **durée moyenne des dix
derniers déploiements réussis de cette cible**, possible parce que le
rapprochement garde l'historique en base. Les échecs sont écartés de la moyenne
(un échec s'arrête en quelques secondes et ferait sauter la barre d'un
déploiement sain à 100 % tout de suite) ; sans historique, pas de barre du tout,
seulement le temps écoulé ; passé la moyenne, la barre reste pleine et le texte
dit « plus long que d'habitude », un « 100 % » nu faisant croire à une fin.
`progressBar` commence par `Number.isFinite` : `Math.min` et `Math.max`
laissent passer `NaN`, et `repeat(NaN)` rend une chaîne vide sans lever.

Ce que la cible dessert vient de son fournisseur (`place`, `repoUrl` de
l'adaptateur) : chez Dokploy, le projet et l'environnement de `project.all`, un
seul appel pour toute l'instance mémoïsé cinq minutes (ce sont des noms
d'organisation, qui bougent rarement), et le dépôt de `application.one` ou
`compose.one`, mémoïsé une heure. Instance injoignable, et l'avis retombe sur le
nom DevEye : il perd ses colonnes, jamais son identité. `application.one` rend
le fournisseur Git au complet, `githubPrivateKey` et `githubClientSecret`
compris : seule l'adresse du dépôt sort de cette lecture, rien n'est mis en
cache, journalisé ni rangé dans le blob de la cible. Le dépôt se lit de deux
façons, guidées par `sourceType` parce que les colonnes d'une source abandonnée
restent en base : `owner` + `repository` sur l'intégration GitHub, `customGitUrl`
sur un git maison. GitLab et Gitea ne sont pas résolus : leurs colonnes ne
portent que des noms, et l'hôte vit sur l'enregistrement du fournisseur. Une URL
de clone qui porte un identifiant en est débarrassée avant d'écrire le lien.

Le lien vers la fiche a la forme
`/dashboard/project/{id}/environment/{id}/services/{kind}/{id}`.

### 3.4 Les fournisseurs

Le module ne parle à aucun fournisseur en direct : handlers et service passent
par `DeployProviderAdapter` (`src/server/providers/types.ts`), un par famille
d'accès (`PROVIDERS`, `providers/index.ts`) : `candidates`, `trigger`,
`history`, `noticeLog`, `fullLog`, `place`, `repoUrl`, `location`, et les
`kinds` de cible qu'il sait déployer. Chacun garde ses propres caches. Une cible
portée par une machine n'a pas d'adaptateur : c'est l'agent qui répond
(`src/server/agent.ts`).

**Dokploy parle tRPC** (`src/server/providers/dokploy.ts`). L'adaptateur passe
par `/api/trpc/<procédure>`, avec des charges utiles enveloppées par superjson
(`{ json: … }` en entrée, en query pour une requête et en corps pour une
mutation ; `{ result: { data: { json } } }` en réponse). Les cibles se découvrent
par `project.all`, imbriquées dans les environnements de chaque projet ; les
piles **compose** sont des cibles au même titre que les applications, d'où
`target_kind`, qui décide de la procédure (`application.deploy` ou
`compose.deploy`, `deployment.all` ou `deployment.allByCompose`). Le décodage est
défensif : champs cherchés sous plusieurs noms, valeur neutre s'ils manquent, si
bien qu'une instance d'une autre version dégrade l'affichage sans planter.

Le journal d'un déploiement Dokploy vient du WebSocket `/listen-deployment`,
hors de tRPC, qui **ne referme jamais la connexion** : c'est un `tail -f`, pas
un téléchargement. C'est le **silence après le dernier octet** qui conclut
(`LOG_IDLE_MS`, 300 ms : le rejeu arrive en une rafale de trames à quelques
millisecondes d'écart), et non l'attente d'une fermeture qui ne vient pas. Un
déploiement **en cours** rend ce qu'il a au premier silence, et la popup le relit
toutes les cinq secondes tant qu'il tourne ; le plafond ne tranche que pour un
flux qui ne s'interrompt jamais : 30 s à la demande, 3 s depuis le suivi de fond
(`DEPLOY_LOG_TIMEOUT_MS`), les lectures d'une même cible étant faites en
parallèle pour ne pas dépasser l'intervalle du tour.

**GitHub Actions** (`src/server/providers/github.ts`) : une cible est un
workflow d'un dépôt, lancé par `workflow_dispatch` sur une branche. Le
catalogue parcourt les trente dépôts les plus récemment poussés du jeton
(`/user/repos?sort=pushed`), quatre à la fois, et est mémoïsé cinq minutes. Un
workflow sans `workflow_dispatch` est refusé, raison dite. L'API ne rend pas
l'exécution qu'elle crée : le suivi la rattache par la date. L'avis montre les
étapes des jobs (faites, en cours, à venir) ; le journal complet concatène le
texte de dix jobs au plus, lus quatre à la fois dans l'ordre des jobs, par une
redirection vers un stockage tiers que le garde revérifie et vers lequel le jeton
ne suit pas ; au-delà d'un million de caractères, seule la fin est gardée. Un
compteur de débit épuisé fait reculer l'accès jusqu'à `x-ratelimit-reset`.

**Une machine** (`provider: 'agent'`) : la cible est un service docker compose
d'une machine enrôlée (`moteur/projet/service`), que son agent déploie en
récupérant son image puis en le recréant seul (`composeDeploy` : `pull` puis
`up --no-deps`). Rien ne se construit sur la machine. `deploy.machines` liste
les machines de l'espace avec ce qui les empêche de porter une cible (agent trop
ancien pour la sonde `composeDeploy`, déploiements refusés par la politique
locale) ; `deploy.candidates({ deviceId })` lit l'inventaire Docker par
`agents.dockerInventory`. **Une machine ne se prête pas sans droit** : déclarer
une cible sur une machine exige la permission Docker d'Appareils sur elle
(`devices.authorize(deviceId, { extras: ['docker'] })`), parce que la cible donne
ensuite à `deploy: write` le pouvoir de relancer ce service. La machine garde le
dernier mot : sa politique locale (`allow_docker` et `allow_docker_deploy` dans
`agent.toml`) peut refuser, et le refus revient comme un échec qui le dit. Une
machine hors ligne refuse le déclenchement. Le verdict attend dans le
processus : `agents.dockerRun` suit l'action, et le journal est le nôtre (en
mémoire tant que l'agent parle, puis dans la ligne du déploiement).

**Une instance Dokploy hors d'Internet se joint par un appareil.** Le garde des
appels sortants de l'app (`Services/netFetch`) refuse une adresse privée
(`OUTBOUND_ALLOW_PRIVATE`, à garder à `false` sur une instance partagée :
l'ouvrir donnerait à tout compte le réseau de l'hôte, par toutes les
fonctionnalités). Un accès Dokploy peut donc désigner un appareil : l'agent
ouvre la connexion de son côté et la relaie (`agents.openTcp`), et `base_url` est
alors l'adresse que voit la machine, `http://127.0.0.1:3000` pour un Dokploy qui
n'écoute que sur elle. Les helpers `deviceRelay` du SDK portent le mécanisme,
partagé avec Bases de données : `relayDeviceOptions` liste les appareils de
l'espace avec ce qui empêche de les choisir (`deploy.credentialDevices`) ;
`authorizeRelayDevice` vérifie, à l'enregistrement de l'accès, que l'appelant a
le droit « Accès au réseau de l'appareil », et l'accès garde l'appareil **et** le
membre qui l'a choisi (`author_user_id`) ; `relayForAuthor` rouvre le relais
pour le travail sans session en revérifiant ce droit sur ce membre à chaque
usage, le suivi de fond compris ; `openDeviceTunnel` pose un écouteur local qui
tient lieu de l'hôte distant. Les appels tRPC passent par un connecteur undici
branché sur cet écouteur, le nom de l'instance gardé pour TLS ; la WebSocket du
journal reçoit sa propre `createConnection`. Hors du garde, une redirection n'est
pas suivie : elle mènerait où l'instance veut. Les trois verrous sont ceux de
Bases de données : le droit du membre, la version de l'agent (sonde `tunnel`),
et la machine, qui ne joint que sa boucle locale sauf hôtes listés dans
`tunnel_targets` (`allow_tunnel` dans `agent.toml`). Un appareil hors ligne fait
reculer l'accès comme une instance injoignable, sans doublement.

### 3.5 Le contrat avec Projets

- `features/projects/src/server/deployLink.ts` porte `projects.deployList`,
  `projects.deployLink` et `projects.deployUnlink`, sous `projects: write` :
  c'est le projet qu'on modifie, lire l'historique et surtout déclencher
  relèvent de `deploy`. Avant de relier, Projets demande au module si la cible
  est visible de l'espace du projet (`DEPLOY_ITEMS_PROVIDER.exists`) et nomme
  les cibles liées par `labelOf`. Sans module installé, relier est refusé en le
  disant.
- Le module lit `PROJECTS_USAGE_PROVIDER` (`features/projects/src/server/usageProvider.ts`)
  pour le compte et la liste des projets qui déploient une cible (ceux de
  l'espace appelant : une cible projetée montre les projets de la fenêtre), et
  pour inscrire un déclenchement dans la **frise** du projet d'où il part
  (`recordEvent`, dans l'espace de la cible, qui ne lève jamais : perdre une
  ligne de frise ne transforme pas un déploiement en échec). Absent, la feature
  dégrade : zéro projet partout.
- Un seul sujet de diffusion, `deploy` : l'onglet d'un projet suit
  `deploy.detail`, ses compteurs d'onglets se relisent à leur prochaine
  ouverture, et c'est Projets qui ravive `projects` quand un déclenchement entre
  dans une frise.
- Côté client, l'onglet Déploiements d'un projet
  (`features/projects/src/client/Deploy/` : `Deploy.tsx`,
  `LinkTargetDialog.tsx`) compose `DEPLOY_CLIENT_PROVIDER` sans importer le
  module : la liste des cibles de l'espace, une cible reliée en entier
  (`LinkedTarget`, qui passe le `projectId` pour la frise, sans l'historique
  complet qui reste un panneau de la feature), et le dialogue de déclaration. Le
  menu « + » de la barre d'onglets du projet ouvre le même dialogue
  (`AddFeatureDialog`).

### 3.6 Le client

`src/client/index.tsx` déclare la tuile (`DeployWidget`), la vue complète
(`Deploy`), les panneaux de réglages (`general` : `TargetGeneralPanel` ;
`sources` : `CredentialsPanel`), `cacheDurationMinutes: 0` (la fiche suit un
déploiement en vol, une instance en cache continuerait de le suivre sans être
vue) et le provider client.

- `TargetDialog` **déclare** seulement, par un accès (« Dokploy ou GitHub
  Actions ») ou « Sur une machine via un agent » ; une machine qu'on ne peut pas
  choisir reste listée avec sa raison. Une fois déclarée, une cible se règle dans
  l'onglet Général de sa fiche (`TargetGeneralPanel` : accès du même
  fournisseur, cible visée, type ou branche, intitulé, suppression), là où le
  bouton de réglages commun mène. Ce panneau est lu une fois à l'ouverture,
  jamais resuivi : `deploy.detail` bouge à chaque état vu par le rapprochement,
  et relire le formulaire à ce rythme effacerait la saisie en cours.
- `CredentialsPanel` tient les accès : Dokploy (adresse et clé d'API, joint en
  « Direct » ou « Par un appareil ») ou GitHub (jeton). Un secret n'est jamais
  relu ; le champ laissé vide veut dire « garder celui en place ». Le « + » du
  sélecteur d'accès d'un dialogue ouvre ce panneau par-dessus, et la cible adopte
  l'accès créé au retour.
- `Deploy.tsx` possède le niveau de présence `l1` (l'identifiant nu de la cible
  ouverte). `TargetList` range les cartes au glisser-déposer (`useDragReorder` du
  SDK) ; `TargetView` porte « Déployer », l'historique et l'ouverture d'un
  journal ; `LogsDialog` relit un journal qui s'écrit encore toutes les cinq
  secondes et s'arrête quand la ligne passe en succès ou en échec.
- `format.ts` fixe le vocabulaire d'état (En attente, En cours, Réussi, Échoué)
  et les budgets client : 35 s pour un aller-retour chez le fournisseur (le
  serveur borne chaque appel à 30 s), 65 s pour un journal.

### 3.7 Le partage entre espaces

`shareTier: 'open'` : une cible se projette dans un autre espace, s'y déplace ou
s'y copie ([`Docs/SHARING.md`](../../Docs/SHARING.md)). L'entrée `items` du
serveur donne le domicile et le nom d'une cible visible (`homeOf`, `labelOf`), et
porte `move` et `copy` :

- `copy.ts` décrit l'arbre d'une cible (`deployTree`) : la ligne de
  `deploy_targets` (cellule scellée `content`) et l'historique `deployments`,
  marqué `cache`. L'accès ne suit pas (`omit`) : c'est une source de l'espace
  quitté, et la copie arrive indéployable, ce que le plan annonce. `admit`
  contrôle le quota `targets` dans l'espace d'arrivée.
- `move.ts` rescelle les cellules sous la clé de l'espace d'arrivée, fait suivre
  le `workspace_id` de l'historique, met `credential_id` à NULL et range la cible
  en fin de liste.
- Les listes déduisent `ctx.items.restrictions()`, et la tuile compte ce que la
  liste montre. `deploy.remove` appelle `ctx.items.forget` : projections,
  restrictions et route de notification ne tiennent à aucune clé étrangère.

### 3.8 L'export du compte

`src/server/accountExport.ts` ([`Docs/ACCOUNT_EXPORT.md`](../../Docs/ACCOUNT_EXPORT.md)) :
`deploy_targets` dans `cibles.json`, `deployments` dans `deploiements.json`
(corps déchiffrés), `ft_deploy_credentials` dans `acces.json` (sans le secret).

---

## 4. Carte du code

```
deveye-feature.json                 l'allowlist des deux tables historiques (deploy_targets, deployments)
package.json                        deveye-feature-deploy ; `ws` en dépendance (le journal Dokploy)
src/index.ts, src/manifest.ts       l'entrée isomorphe ; le descripteur étalé, ressources deploy.count / deploy.list /
                                    deploy.detail, capacités notify / agents / devices.read, quota targets,
                                    réglages { feature: ['sources'], item: ['general'] }, lien « À propos » vers Mail
src/contracts/domain.ts             la cible, le déploiement, le candidat, l'accès (Dokploy ou GitHub), la machine,
                                    les quatre états, les quatre types de cible, le lien perdu
src/contracts/commands.ts           les dix-sept commandes (préfixe `deploy.`)

src/server/index.ts                 serverEntry : dépôt, migrations, handlers, service, `items` (domicile, nom, move, copy),
                                    quota `targets`, export du compte, provider DEPLOY_ITEMS_PROVIDER offert à Projets
src/server/repo.ts                  cibles, déploiements, accès (ft_deploy_credentials), listTargetsDue, stock du quota
src/server/_shared.ts               Stored*, loadTarget / loadHomeTarget, targetCipherFor, toTarget, toDeployment,
                                    toCredential, loadAccess, le singleton du suivi (setSync / wakeSync / startAgentDeploy /
                                    liveAgentLog), le contrat de Projets (compte, liste, frise)
src/server/handlers.ts              les dix-sept commandes, en defineSdkFeature
src/server/service.ts               DeploySync : le rapprochement de fond, le lien perdu, le message vivant,
                                    les déploiements par une machine
src/server/notice.ts                la mise en forme des messages Discord (barre, journal, lien perdu) ; helpers Discord de
                                    l'app, importés avec leur raison
src/server/agent.ts                 les cibles portées par une machine : identifiant de service, inventaire, capacité
src/server/historyCache.ts          l'historique que le client vient de lister, pour retrouver un journal
src/server/providers/types.ts       le contrat d'un fournisseur ; providers/index.ts, la table PROVIDERS
src/server/providers/dokploy.ts     l'adaptateur tRPC + le WebSocket du journal, le relais par un appareil, et ses caches
src/server/providers/github.ts      GitHub Actions : workflow_dispatch, exécutions, étapes, journaux
src/server/migrations/              001 les fournisseurs et les cibles par machine ; 002 l'accès par un appareil ;
                                    003 le lien perdu
src/server/copy.ts, move.ts         l'arbre d'une cible ; sa copie et son déplacement entre espaces
src/server/accountExport.ts         l'export du compte
src/server/uninstall.sql            DROP de ft_deploy_credentials (les tables historiques restent)
src/server/*.test.ts                handlers (harnais SDK), service (Dokploy simulé), notice (les calculs), repo (le SQL
                                    des pauses et du stock), historyCache, accountExport
src/server/providers/*.test.ts      dokploy (le journal sur une vraie WebSocket), dokploy.relay (l'instance jointe par un
                                    relais), github (réseau simulé)

src/client/index.tsx                clientEntry : tuile, vue complète, panneaux Général et Sources, provider client
src/client/Deploy.tsx               liste + fiche ; possède le niveau live `l1`
src/client/TargetList.tsx           les cartes et leur glisser-déposer (useDragReorder du SDK)
src/client/TargetView.tsx           le cœur partagé avec l'onglet d'un projet : « Déployer », historique, journaux
src/client/TargetDialog.tsx         déclarer seulement, par un accès ou sur une machine ; le « + » de l'accès ouvre
                                    Réglages → Sources
src/client/TargetGeneralPanel.tsx   l'onglet Général d'une cible : accès, cible visée, type ou branche, intitulé, suppression
src/client/CredentialsPanel.tsx     les accès Dokploy et GitHub (panneau Sources de la feature)
src/client/LogsDialog.tsx           le journal complet d'un déploiement, relu tant qu'il tourne
src/client/DeployWidget.tsx         la tuile d'accueil (deploy.count)
src/client/provider.tsx             ce que l'onglet d'un projet compose (DEPLOY_CLIENT_PROVIDER)
src/client/api.ts, format.ts        featureApi(manifest) ; les libellés d'état, de lieu et de date, les budgets client
src/client/style.module.css         la feuille du module
```

Ce que le module importe de l'app, avec sa raison à chaque import :
`Services/netFetch` (le garde des appels sortants, dans les handlers et les deux
adaptateurs), `Services/alertCore` (`formatMoment`, `formatDuration`, dans le
service) et `Services/notices/shared` (les helpers Discord, dans `notice.ts`).
La déclaration ambiante de `ws` est `src/types/ws.d.ts` de l'app, incluse par le
projet serveur des modules.

Côté Projets : `features/projects/src/server/repo/links.ts` (la table
`project_deploy_links`, ses lectures et ses comptes),
`features/projects/src/server/deployLink.ts` (les trois commandes de liaison),
`features/projects/src/server/usageProvider.ts` (`PROJECTS_USAGE_PROVIDER`, dont
`recordEvent`) et `features/projects/src/client/Deploy/` (l'onglet d'un
projet).

---

## 5. Les tables

| Table                   | À qui   | Contenu                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy_targets`        | socle   | une cible : `provider` (`dokploy`, `github`, `agent`), `target_kind`, `external_id` en clair (il porte l'unicité : `(workspace_id, credential_id, external_id)` et `(workspace_id, device_id, external_id)`), `credential_id` (sans clé étrangère), `device_id` (en cascade sur `devices`), `sort_order`, `synced_at`, `content` chiffré (`name`, `ref`) |
| `deployments`           | socle   | un déploiement : `external_id`, `status`, `started_at`, `finished_at`, `triggered_by_user_id` (`NULL` pour une tâche de fond ou un compte supprimé), `notified`, `content` chiffré (`title`, `description`, `url`, `noticeIds`, `log` d'une machine) ; en cascade sur la cible                                                                           |
| `ft_deploy_credentials` | module  | un accès : `provider`, `label`, `base_url`, `secret_enc` chiffré à l'étage ouvert, `device_id` et `author_user_id` (mis à `NULL` à la suppression de l'appareil ou du compte : l'accès reste, et dit ce qui lui manque), `unreachable_since`, `unreachable_error`, `unreachable_notified` ; `uninstall.sql` la détruit                                   |
| `project_deploy_links`  | Projets | la liaison `(project_id, target_id)`, en cascade des deux côtés                                                                                                                                                                                                                                                                                          |

Les deux tables historiques sont créées par les migrations du socle et listées
dans l'allowlist de `deveye-feature.json`, qui les dispense du préfixe
`ft_deploy_` ; `src/server/migrations/` les fait évoluer, et une table neuve y
prendrait ce préfixe. Les trois migrations du module sont rejouables : chaque
ajout est gardé par l'état lu dans `INFORMATION_SCHEMA`, et une colonne qui
reçoit une clé étrangère vers `devices.id` prend la collation de cette colonne,
lue au moment de l'exécution.

---

## 6. Configuration

Aucune variable `DEPLOY_*` : les bornes du rapprochement sont des constantes de
`src/server/service.ts` (§3.2). Une variable de l'app concerne le module :
`OUTBOUND_ALLOW_PRIVATE` (défaut `false`), qui décide si un accès « Direct » peut
viser une adresse privée ; le chemin « Par un appareil » n'en a pas besoin.

---

## 7. Les quotas de l'offre

Une cible sondée interroge son fournisseur chaque minute, à vie : c'est ce que
l'offre borne. Le manifest déclare le quota `targets` (un **stock**, libellé
« cibles de déploiement »), ce qui donne la limite `deploy.targets`
([`Docs/QUOTAS.md`](../../Docs/QUOTAS.md)). Les valeurs sont celles du module de
facturation des comptes (`src/server/plans.ts` de Billing) : **3** cibles en
offre gratuite, **20** en Pro, tous espaces du propriétaire confondus. Une
installation sans module de facturation n'a aucune limite.

Le contrôle est dans `deploy.add` (`ctx.quota.assert('targets', …)`), **après**
la recherche qui rend l'ajout idempotent : redéclarer une cible n'en ajoute
aucune et ne doit jamais buter sur la limite ; et dans `admit` de `copy.ts`
pour une copie. Un déplacement ne change rien au compte. Les cibles portées par
une machine ne comptent pas (`provider <> 'agent'` dans le compteur et le
stock) : rien n'est sondé, et les machines ont leur propre limite. Le stock est
listé du plus ancien au plus récent : après un retour à une offre plus basse,
l'excédent passe en pause, le plus récent d'abord. Une cible en pause est écartée
de `listTargetsDue`, refuse `deploy.trigger` et `deploy.log`
(`ctx.quota.assertActive`), sert son historique local à `deploy.history` plutôt
que d'interroger le fournisseur, et se présente avec `planPaused` à l'écran.

---

## 8. Notifications

Voir §3.3 : un avis à l'atterrissage de chaque déploiement, échec comme succès,
ceux lancés ailleurs compris ; un avis quand le lien avec l'instance d'un accès
se perd, puis revient, vers les canaux de toutes les cibles qu'il dessert. Les
canaux sont ceux de la feature, la sélection vit sur chaque cible, et Discord
porte en plus un message vivant qui suit le déploiement. La fiche « À propos » du
module relie Mail (`links` du manifest) : les avis par courriel partent par un
compte Mail.

---

## 9. Tests

```bash
npm run test:features
```

depuis `DevEye/`. Les tests du module tournent sans base ni réseau, sauf
`dokploy.test.ts` et `dokploy.relay.test.ts`, qui montent une vraie WebSocket
locale pour reproduire le comportement qui compte : le serveur ne ferme jamais.
