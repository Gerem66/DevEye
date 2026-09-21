# Audience — le suivi d'usage des projets livrés

> Écrit le 13 août 2026, à la fin du chantier qui l'a introduite ; relu le
> 21 août 2026. Compagnon de [Projets](../projects/README.md) : celui-ci suit le
> travail, [Git](../git/README.md) suit le code, celui-là suit **ce que les gens en
> font**. Il dit _pourquoi_ ; le code dit comment.
>
> Depuis : les sites se **partagent entre espaces** comme les autres éléments
> de premier rang (`Docs/SHARING.md`), et la fiche d'un site porte le bouton de
> réglages commun (partage, permissions par rôle : `Docs/SETTINGS.md`).
>
> 28 août 2026 : Audience est la **douzième native rapatriée** sur le SDK des
> modules (`features/audience`, [Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md)), et la
> première à ouvrir des routes HTTP publiques (capacité `routes.public`). Ce
> document décrit l'état après ce rapatriement ; la section 6 en est la carte.

DevEye savait piloter le travail, suivre le code, surveiller l'infra — mais rien
ne disait ce que les visiteurs faisaient des projets une fois livrés. Il
manquait la boucle de retour.

Documents voisins à respecter : [Docs/WORKSPACES.md](../../Docs/WORKSPACES.md),
[Docs/LIVE.md](../../Docs/LIVE.md), [Bases de données](../database/README.md),
[Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md).

---

## 1. La forme, et pourquoi c'est la même que git et les bases

Un **site suivi** appartient à l'espace. Plusieurs projets peuvent suivre le
même, certains sites ne servent aucun projet, et un projet n'en garde qu'une
**liaison** (`project_audience_links`, PK composite, FK en `CASCADE`).

C'est la quatrième entité de cette famille — dépôts (069), services surveillés
(067), bases (068), sites (077) — et la forme est désormais établie : ce sont
des objets d'espace, pas des propriétés d'un projet.

---

## 2. Les invariants

### 2.1 Toujours à l'étage ouvert

Non négociable, et pour une raison plus dure que celle des bases :
**l'ingestion tourne sans session**, depuis une requête HTTP anonyme émise par
un navigateur qui ne connaît pas DevEye. `open_dek_wrapped` est le seul étage
que le serveur sait relire seul.

Conséquences assumées, identiques à git et aux bases :

- rien ici ne demande jamais de mot de passe ;
- **un projet confidentiel ne peut pas suivre de site**, et le passer en
  confidentiel délie les siens (les sites, eux, survivent).

### 2.2 Une statistique est un `GROUP BY`, donc rien de ce qu'on agrège n'est chiffré

C'est le nœud de tout le module. La sortie est celle que le dépôt emploie déjà —
les colonnes `*_ref` — poussée jusqu'à une **table de dimensions** :

```
audience_labels    site_id, kind, label_ref, content   ← le libellé chiffré, une fois
audience_sessions  visitor_ref, dims (id entiers), tz_offset, …
audience_events    session_id, ts, kind, path_id, name_id   ← ~50 octets
audience_daily     site_id, day, views, sessions, visitors  ← jamais purgé
```

Un chemin vu mille fois est stocké **une** fois ; les tables de faits ne portent
que son identifiant entier. On agrège sans clé, et l'on ne déchiffre que les
quelques dizaines de libellés qu'un écran affiche réellement.

**Une seule table de dimensions** discriminée par `kind`, et non six : une ligne
de rekey au lieu de six, un seul cache, un seul chemin de résolution.

### 2.3 Ce qui reste en clair, et pourquoi c'en est la place

`public_key`, `origins`, `active`, `platform`. Ce sont exactement les champs dont
l'ingestion a besoin pour **router une requête sans session ni clé** — ce que
[Projets](../projects/README.md) §1.2 autorise explicitement. Ils sont de toute
façon publics : la balise les expose dans le HTML de chaque page suivie.

### 2.4 Aucun cookie, aucun identifiant persistant

`visitor_ref = sha256(sel du jour + clé du site + IP + user-agent)`, tronqué à
16 caractères. **Ni l'IP ni le user-agent ne sont stockés** ; le sel est dérivé
d'un secret serveur et de la date UTC. Ce secret est, depuis le rapatriement
en module, une clé **dérivée** de la clé serveur par le SDK
(`deps.keys.derive('audience', 'visitor-salt', 32)`, HKDF, jamais stockée),
et non plus `CRYPT_KEY_A` brute, qu'un module ne lit pas. Même propriété :
stable d'un redémarrage à l'autre tant que la clé serveur ne change pas.
Conséquence assumée, une seule fois : les condensés de visiteurs ont changé à
la migration. Un visiteur persistant a été compté « nouveau » une fois (sa
session suivante ne s'est pas rattachée à l'ancienne empreinte) ; les condensés
anonymes tournaient déjà chaque jour, rien n'a bougé pour eux. C'est le prix
de ne plus manipuler la clé serveur.

Trois conséquences, toutes voulues :

- rien à faire accepter par un bandeau de consentement ;
- un même visiteur n'est **pas** reconnaissable d'un jour à l'autre — donc pas
  de « visiteurs récurrents », et c'est le prix assumé ;
- la clé du site entre dans le condensé, donc croiser les audiences de deux
  sites est mécaniquement impossible.

Le « par qui » nominatif vient d'ailleurs, et seulement si le site le veut : un
`identity` que **lui** envoie pour ses propres utilisateurs connectés.

---

## 3. L'ingestion : la seule porte de DevEye ouverte sur Internet

### 3.0 L'adresse vient du `.env`, jamais du navigateur

`AUDIENCE_ORIGIN` (à défaut `PUBLIC_ORIGIN`) porte l'adresse par laquelle les
pages suivies atteignent l'ingestion, et c'est le serveur qui la rend au client
(`audience.get`, par `ctx.origins.public` : le contexte du SDK la porte pour
tous les modules, aucun ne lit la variable). La déduire de
`window.location.origin` — ce que faisait la première version — donnait une
balise juste en développement et **fausse en production** : l'application vit
derrière le VPN, l'ingestion doit être joignable sans lui, donc les deux
adresses diffèrent par construction.

En développement sur l'hôte, le client est servi par Vite sur `:5173` : `/t.js`
est donc aussi **proxifié** dans `client/vite.config.ts`, à côté de `/api` et
`/ws`. Sans cette entrée, Vite cherche le script parmi ses propres fichiers et
rend un 404 — la balise semble cassée alors que le serveur la sert parfaitement.

### 3.0 bis Un second écouteur, et non une garde

L'application vit derrière le VPN ; l'ingestion doit être joignable sans lui.
Trois façons d'y arriver, et deux sont moins sûres :

| Approche                      | Ce qui la sépare du monde                                          |
| ----------------------------- | ------------------------------------------------------------------ |
| Règle de chemin dans le proxy | une configuration hors dépôt, qu'un redéploiement peut perdre      |
| Garde sur l'en-tête `Host`    | un `if`, avec les routes internes toujours déclarées derrière      |
| **Second écouteur**           | **rien à séparer : les routes internes n'y sont pas enregistrées** |

C'est la troisième. `PUBLIC_LISTEN_PORT` démarre un serveur qui ne déclare que
les **routes publiques des modules** (`modulePublicRoutes`, capacité
`routes.public` : aujourd'hui `/t.js`, `/api/t/b` et `/api/t/e`, déclarées par
le service d'Audience) et une sonde de vivacité. Il n'existe aucun chemin de
code de ce port vers l'authentification, la socket, la flotte d'appareils ou
le client web. Ni cookies, ni WebSocket, ni fichiers statiques, ni repli SPA
n'y sont montés.

Vide, il n'y a pas de second serveur et les routes publiques restent sur le port
principal : c'est le cas du développement, et celui d'une installation qui n'a
pas besoin de la séparation.

⚠️ **`trustProxy` doit rester actif sur ce second écouteur.** Le plafond de
débit compte par IP ; sans lui il verrait celle du proxy, et le premier visiteur
un peu actif fermerait la porte à tous les autres.

**Même processus, et c'est une contrainte.** Le service du module
(`AudienceIngest`) prévient les écrans par `deps.live.changed`, donc par
`LiveHub`, dont l'état est local au processus ([Docs/LIVE.md](../../Docs/LIVE.md) §6). Un
conteneur séparé écrirait les mesures sans que personne ne soit averti : le
rafraîchissement à la minute cesserait de fonctionner, **silencieusement**.
Partager le processus, c'est partager la file, les caches et le hub. C'est
aussi pourquoi le second écouteur monte les routes des services **déjà créés**
par `buildApp` : le module déclare les mêmes routes sur chaque écouteur, c'est
l'écouteur qui change, pas l'ingestion.

### 3.1 Trois obstacles dans le socle, trois réponses

1. **Le CORS était global** sur `PUBLIC_ORIGIN`. Il est désormais **délégué par
   requête** : `*` sans identifiants pour les chemins publics que les modules
   ont déclarés (`isModulePublicPath`, les trois routes d'Audience),
   `PUBLIC_ORIGIN` avec cookies partout ailleurs. Le délégateur est la seule
   forme qui reçoive la requête.
2. **Le plafond de débit global** (200/min) est dimensionné pour une interface
   humaine ; les routes d'ingestion ont le leur (600/min par IP, le `rateLimit`
   que le module pose sur ses deux POST). La clé du site n'entre pas dans la
   clé de comptage : le plafond s'applique **avant** que le corps ne soit
   analysé.
3. **La clé de site est publique** et ne protège rien. Ce qui filtre, c'est la
   liste d'**origines autorisées** par site, confrontée à l'en-tête `Origin`
   côté serveur — là où un client ne peut pas mentir. Le CORS, lui, est un
   mécanisme que le navigateur applique à lui-même : ce n'est pas une garde.

### 3.2 Toujours `204`

Clé inconnue, origine refusée, site éteint, charge utile invalide : même
réponse. Un endpoint public qui distingue ses refus est un **oracle** — il dirait
à qui le sonde quelles clés existent, et laquelle vient d'être révoquée.

### 3.3 La requête ne touche pas la base

`accept()` résout le site depuis un cache mémoire, condense le visiteur, et
range dans une file. L'écriture a lieu **une fois par seconde, en lot**.

Le prix, à dire franchement : **une seconde d'événements est perdue** si le
processus tombe entre deux vidanges. C'est de l'analytique, pas de la
comptabilité, et la garantie inverse aurait coûté un aller-retour SQL synchrone
à chaque page vue de chaque site.

La file est **bornée** (20 000). Au-delà, on jette et on le journalise : une base
indisponible ne doit pas transformer la mémoire du processus en file sans fond.

### 3.4 CORP : un 200 parfait que le navigateur jette

`@fastify/helmet` pose `Cross-Origin-Resource-Policy: same-origin` sur **toutes**
les réponses du serveur. C'est le bon défaut pour une application — et c'est
exactement ce qu'il ne faut pas sur `/t.js`, dont l'objet est d'être chargé
depuis ailleurs.

La panne ne ressemble à rien de connu : le serveur répond `200`, la réponse
arrive complète, puis le navigateur la jette avec
`ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. **Aucun en-tête CORS n'est en cause** —
on peut les régler parfaitement sans que rien ne change, parce qu'un
`<script src>` est une requête `no-cors`, et que c'est là que CORP s'applique.

Les trois routes publiques posent donc `Cross-Origin-Resource-Policy:
cross-origin`. Sur l'ingestion c'est une précaution — ses requêtes sont en mode
`cors`, hors du champ de CORP aujourd'hui — mais rien ne garantit qu'un client
futur les émettra de la même façon.

> **Ce que ça dit du banc d'essai.** Le premier jeu de vérifications montait
> Fastify avec le CORS et l'analyseur de contenu, mais **pas helmet** : il ne
> pouvait donc pas voir ce défaut, et il annonçait tout vert. Un banc qui ne
> monte pas les mêmes couches que la production ne vérifie pas la production. Il
> monte helmet depuis, et l'assertion a été éprouvée en retirant le correctif —
> une vérification qui ne peut pas échouer ne vérifie rien.

### 3.5 `text/plain`, et ce n'est pas un détail

`navigator.sendBeacon` avec un `Blob` de type `text/plain` produit une requête
**simple** au sens CORS : aucune requête préalable `OPTIONS`. C'est ce qui fait
tenir la mesure en un aller simple depuis une page tierce. D'où l'analyseur de
contenu ajouté dans `app.ts` — aucune autre route n'accepte ce type.

### 3.6 Ce qui prépare React Native sans le construire

Le contrat d'ingestion ne suppose **rien du navigateur** : aucun champ web n'est
requis, `path` désigne une route _ou_ un écran, les trois champs d'appareil
peuvent être renseignés explicitement par un client natif qui les connaît, et
`at` permet de livrer ce qu'on a mis de côté hors ligne (borné à 24 h côté
serveur — une horloge fausse ne doit pas dater une visite de 2038).

`audience_sites.platform` (`web` | `app` | `both`) décide si l'`Origin` est
confronté : un binaire natif n'en envoie aucun, et refuser son absence lui
fermerait la porte pour de bon.

Un module RN futur sera ~40 lignes appelant le même `POST /api/t/b`, sans une
ligne de serveur à toucher. À dire franchement : la clé d'un site `app` est
extractible du binaire, et seuls elle et le plafond de débit le protègent. C'est
ce que font Plausible et PostHog ; il n'existe pas mieux sans imposer un compte
à chaque visiteur.

---

## 4. Ce que ça donne à l'usage

| Vue                    | Contenu                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sites**              | tous les sites de l'espace, visiteurs et vues sur 24 h, état, nombre de projets                                                                                                                                              |
| **Un site**            | bandeau (vues, visiteurs, visites, durée, rebond) avec **écart à la période précédente** · courbe · top pages et provenances · navigateurs / systèmes / appareils · carte jour × heure · fuseaux · événements · utilisateurs |
| **Installer**          | un bouton unique dans l'en-tête de la fiche, quelle que soit la section : étape 1 le bloc à coller (la balise, ou le `<form>` du formulaire ouvert), étape 2 ce qui est arrivé depuis                                        |
| **Onglet d'un projet** | les sites reliés, même `SiteView`                                                                                                                                                                                            |

Six décisions d'écran qui méritent d'être connues :

- **L'écart est la moitié de l'information.** « 1 240 vues » ne dit pas s'il faut
  regarder de plus près ; « 1 240 vues, +18 % » le dit. La période de comparaison
  est de même longueur et immédiatement antérieure — comparer à « le mois
  dernier » calendaire ferait varier le diviseur avec le nombre de jours, et un
  février paraîtrait toujours en baisse.
- **Un site sans aucune mesure ne montre pas cinq zéros**, il montre son écran
  d'installation. Cinq zéros et une courbe plate feraient chercher une panne là
  où il manque simplement une balise.
- **L'heure de la carte d'activité est celle du visiteur**, reconstituée depuis le
  décalage qu'il a déclaré. En heure serveur, une audience répartie sur trois
  fuseaux se moyenne en un aplat qui ne dit rien.
- **Tout ce qu'un écran montre se lit sur les faits, jamais sur un cache.** La
  seule exception serait la silhouette de sept jours du sommaire, qui sort de
  l'agrégat journalier ; ses deux derniers jours, les seuls que le ménage
  horaire recalcule, sont donc repris sur les événements bruts. Sans quoi la
  carte afficherait « 412 vues (24 h) » au-dessus d'une barre du jour vieille
  d'une heure.
- **Le rebond a des pages de transit.** Une application qui ouvre toujours un
  écran de chargement puis une connexion avant sa première vraie page aurait un
  rebond nul, ou absurde, selon le nombre d'écrans automatiques. Le site déclare
  ces chemins (onglet Fréquentation) et le rebond ne les compte pas : une visite
  qui n'a vu que ceux-là, ou une seule autre page, est un rebond. Ils restent
  comptés partout ailleurs. Le calcul se fait à la lecture, sur les faits
  (`repo.metrics` recompte les vues par visite en écartant leurs libellés,
  retrouvés par condensé), donc changer la liste vaut pour tout l'historique.
  La liste vit dans le contenu chiffré du site : ce sont des noms de pages.
- **Un classement n'est jamais la liste exhaustive.** Huit lignes d'emblée,
  « Tout afficher » va jusqu'au plafond de cinquante, et une liste au plafond
  le dit. Chaque ligne porte au survol ce que ses deux nombres comptent, parce
  que la première colonne ne compte pas la même chose selon l'axe (des vues
  sur une page, des déclenchements sur un événement) et que « 312 vis. » seul
  ne dit pas s'il s'agit de visites ou de visiteurs.

Les graphes sont du **SVG écrit à la main**, `viewBox` fixe, sans
`ResizeObserver` — le patron d'`UptimeChart`. Aucune dépendance de graphes n'a
été ajoutée : le client n'en avait pas, et n'en voulait pas.

---

## 5. Le direct

**Deux régimes, et c'est la distinction qui compte.**

- Les mutations d'un humain (déclarer un site, le régler, renouveler sa clé, le
  supprimer) gardent `mutates` : instantanées, sous le plancher de 200 ms du hub.
- Le **flux d'ingestion** est coalescé à **une diffusion par minute et par
  espace**, dans `AudienceIngest` (`features/audience/src/server/service.ts`,
  par `deps.live.changed`). Diffuser par événement ferait re-solliciter
  l'écran de tous les membres à chaque visite.

⚠️ **Ne pas déplacer cette coalescence dans le hub.** `TOPIC_FLOOR_MS` (200 ms)
doit rester strictement sous l'anti-rebond client de 250 ms, sinon on ouvre une
fenêtre d'écritures jamais vues ([Docs/LIVE.md](../../Docs/LIVE.md) §4). Les deux valeurs
n'ont rien à voir : l'une est un invariant du moteur, l'autre un choix de
produit.

`LiveHub.changed()` ne fait déjà rien quand la salle est vide : personne ne
regarde, rien ne part. Il n'y avait donc pas de seconde garde à écrire.

**Le sujet `audience` invalide les quatre clés d'un coup** — `count`, `list`,
`detail`, `stats`. C'est délibéré : ce battement doit rafraîchir _tout_ ce qui
montre de l'audience au même instant (tuile d'accueil, liste, fiche ouverte,
onglet d'un projet), sinon deux écrans de la même donnée divergeraient à la même
seconde chez la même personne. `audience.stats` reste distincte de
`audience.detail` pour la raison inverse : un réglage humain n'a aucune raison
de faire relire six requêtes d'agrégat.

---

## 5 bis. Les entonnoirs

### Le découpage, et pourquoi il tient tout

Le site suivi émet des **signaux nommés** — une page vue, un
`deveye.event('devis-etape-2')`. L'entonnoir, lui, se compose **dans DevEye**, à
partir de ce qui a déjà été observé. Trois conséquences, et ce sont elles qui
font la valeur du découpage :

- mesurer un autre parcours ne demande **aucun redéploiement** du site suivi ;
- un entonnoir supprimé ne perd **aucune mesure** — il n'a jamais rien collecté,
  il relit. Le recréer à l'identique rend exactement les mêmes chiffres ;
- un entonnoir peut être défini **avant** que le site n'émette le signal : la
  marche compte alors zéro, ce qui est la vérité et non une erreur.

### La règle de rétention, et il faut la connaître

> Une visite atteint la marche _i_ si la **première occurrence** de chacune des
> marches 1.._i_ s'est produite **dans l'ordre**.

Deux choses en découlent, et les taire serait malhonnête : un visiteur qui
revient en arrière puis repart peut ne pas être compté ; et un entonnoir dont
deux marches reconnaissent la même valeur les voit franchies ensemble. C'est le
prix d'une définition déterministe qui tient en **une** requête — et une
définition floue aurait été pire qu'une définition stricte qu'on énonce.

Techniquement : une sous-requête groupe par session et rend la première
occurrence de chaque marche (`t1`, `t2`…), la requête extérieure somme les
conditions cumulées (`t1 IS NOT NULL AND t2 >= t1 AND …`). Une marche dont le
libellé n'existe pas coupe la construction : elle vaut zéro, et tout ce qui la
suit aussi.

⚠️ **`>=` et non `>`.** Les horodatages sont à la seconde et le script groupe
ses envois sur une demi-seconde : un même clic produit couramment une vue et un
événement dans la **même** seconde. Avec `>`, tout entonnoir dont deux marches
consécutives naissent du même geste — « ouvrir /devis » puis « devis-ouvert » —
compterait zéro conversion, sans rien pour l'expliquer.

⚠️ Les seules parties **interpolées** de cette requête sont un indice de colonne
et un nom de colonne d'événement, tirés d'un vocabulaire fermé et bornés par
`AUDIENCE_FUNNEL_MAX_STEPS`. Les identifiants de libellés sont liés. C'est la
discipline de `DIMENSION_SOURCE` : on ne met dans le texte de la requête que ce
que le serveur a lui-même écrit.

### Ce que l'écran désigne

Une suite de barres décroissantes se lit vite mais ne **désigne** rien. La
question qu'on se pose en ouvrant cette section est « où est-ce que je perds le
plus de monde », et y répondre demande de comparer les chutes entre elles, pas
les hauteurs — d'où la marche la plus coûteuse mise en avant, et une seule (à
égalité, la première l'emporte).

Les largeurs sont rapportées à la **première** marche : un entonnoir se lit
comme une part de ceux qui sont entrés. Les rapporter à la marche précédente
aurait donné des barres presque pleines partout, masquant exactement ce qu'on
vient voir.

Le dialogue propose en **suggestions** les pages et les événements réellement
observés sur un an. Ce n'est pas un confort : le nom exact d'un signal vit dans
le code du site suivi, et le retaper de mémoire est le meilleur moyen de définir
une marche qui ne comptera jamais rien — sans que rien ne le signale, puisque
zéro est une réponse valable. La saisie libre reste ouverte, pour préparer une
mesure avant la mise en ligne.

---

## 5 ter. Les retours

Beaucoup de petits sites n'ont besoin d'un serveur que pour une chose :
recueillir un message, un sondage, un signalement. Audience savait **mesurer**
et ne savait rien **recevoir** ; il fallait donc un service tiers pour ce que
la feature avait déjà sous la main, une porte publique, une clé par site, une
liste d'origines et un chiffrement au repos.

Un **formulaire** est le canal nommé qui reçoit (`contact`, `sondage-2026`), et
un **retour** est un objet de champs nommés. Quatre arbitrages ne se devinent
pas depuis le code.

### Un formulaire se déclare, il ne naît pas d'une réception

La première version le créait à son premier envoi : rien à déclarer avant, une
faute de frappe visible plutôt qu'un silence. C'était un angle mort. La clé
publique est **dans le HTML de la page** ; qui la lit pouvait donc faire
apparaître vingt canaux aux noms de son choix, et autant de colonnes dans le
tableau. On ne prête pas son interface à un inconnu pour une commodité de
branchement.

Un formulaire déclare donc son nom et ses **questions typées** (`text`,
`email`, `number`, `boolean`, `choice`). Le type n'est pas une décoration : un
`<form>` HTML n'envoie que des chaînes (`"4"`, `"on"`, et **rien du tout** pour
une case décochée), et c'est lui qui les ramène à la bonne valeur avant qu'on
les range et qu'on les compte. Sans lui, la même réponse compterait pour deux
valeurs distinctes selon la porte par laquelle elle est entrée. Il permet aussi
d'**engendrer le formulaire à coller**, et de montrer dans les résultats une
question déclarée que personne n'a remplie, ce qu'un comptage seul ne peut pas
savoir.

Deux échappatoires, toutes deux éteintes par défaut : le mode `auto` d'un
formulaire (tout est accepté, les colonnes se découvrent) et l'interrupteur
`forms_auto` d'un site (un nom inconnu crée son canal). `validate.ts` est pur et
testé à part, comme `answers.ts`, et il **normalise** en même temps qu'il
refuse : la réception et `indexableAnswers` voient donc la même valeur.

### Les origines disent trois choses, et le vide est le plus sévère

Vide, plus rien n'entre. `*`, tout entre. Sinon, la liste. La première version
acceptait **tout** sur une liste vide, ce qui faisait du réglage par défaut le
plus permissif de tous : un site à peine créé était une boîte aux lettres
ouverte à qui lisait sa clé. La migration `002` écrit `*` sur les sites
existants sans origine, pour qu'aucun ne s'arrête en silence au déploiement et
que le réglage devienne relisible.

Cette garde n'arrête qu'un navigateur : l'en-tête `Origin` est posé par lui, et
un script y met ce qu'il veut. Elle empêche un **autre site** d'abuser de la clé
depuis le navigateur d'un visiteur, ce qui est déjà l'essentiel. Ce sont les
quotas qui bornent un envoi forgé.

Et pour lever la méprise la plus commune : **le CORS n'a jamais rien protégé
ici**. Un POST cross-origin en `text/plain` ou `urlencoded` est une requête
« simple » au sens CORS ; le navigateur l'envoie toujours et empêche seulement
d'en lire la réponse.

### La réception est synchrone, la mesure ne l'est pas

`accept()` range en mémoire et rend la main ; `submit()` écrit avant de
répondre. C'est la seule divergence entre les deux portes, et elle est
délibérée : une vue perdue au redémarrage n'est rien, un message que personne
ne lira l'est. Le débit s'y prête, un retour n'arrivant pas à la cadence des
pages vues.

### Les compteurs sont tenus à la réception, pas calculés à la lecture

Même impasse qu'au §2.2 : la charge utile est chiffrée, un `GROUP BY` dessus
est impossible par construction. La sortie est la même que pour les libellés,
poussée d'un cran :

```
ft_audience_form_labels   form_id, kind('field'|'value'), label_ref, content
ft_audience_answers       form_id, field_id, value_id, hits
```

Chaque couple (question, réponse) est haché à l'arrivée et incrémente un
compteur ; lire la vue Résultats ne déchiffre alors que les quelques dizaines
de libellés affichés, que le formulaire porte cent retours ou cinq cent mille.
Le prix est celui de tout agrégat pré-calculé : **le regroupement est figé à la
réception**, et renommer une question ne recompte pas le passé.

Deux bornes évitent qu'un champ de texte libre ne fasse une ligne de dimension
par visiteur : au-delà de 60 caractères, ou au-delà de 50 valeurs distinctes
pour la même question, la réponse tombe dans le **seau** `value_id = 0`, qui ne
garde qu'un nombre. L'écran l'annonce (« N réponses en texte libre ») plutôt que
de faire croire qu'elles n'existent pas.

La suppression d'un retour rejoue les mêmes règles sur sa charge utile
déchiffrée pour décrémenter exactement ce qu'il avait compté. D'où
`answers.ts`, qui porte les règles pures **et** l'écriture qui les applique
(`countAnswers`) : la réception et la suppression passent par la même fonction,
et les séparer serait la meilleure façon de les faire diverger, ce que rien ne
signalerait, les compteurs se contentant de dériver. Cette fonction ne dépend
pas du service d'ingestion, pour qu'un service absent ne laisse jamais passer
une ligne effacée sans la décompter.

Vider ou supprimer un formulaire, en revanche, efface les compteurs en bloc, ce
qui est exact et sans arithmétique.

### Aucune rétention sur les retours, mais des quotas

`retention_days` purge les événements bruts. Il ne touche pas aux retours, et
c'est voulu : un événement de mesure est jetable, un message est du contenu que
l'utilisateur a demandé à collecter, et l'effacer en silence au bout de N jours
serait une perte de données.

Le plafond de 50 000 par formulaire reste, mais **il ne peut pas être la seule
borne** : à lui seul, le brûler ne remplit pas la base, ça condamne le
formulaire jusqu'à ce qu'on le vide à la main. C'était un déni de service offert
à qui connaît la clé. Deux quotas en fenêtre glissante s'y ajoutent, sur le
motif du plafond horaire des signalements du socle (un `COUNT(*)` servi par un
index composite, sans table de compteurs ni fenêtre à purger) :

- **par adresse et par formulaire** (défaut 5/h) : l'envoi est ignoré, rien ne
  se ferme. C'est une provenance qui insiste ;
- **par formulaire, toutes adresses** (défaut 200/h) : le formulaire **se
  ferme**, daté et motivé (`closed_at`, `closed_reason`). Un flot distribué ne
  s'essouffle pas tout seul, et une porte close et réversible vaut mieux qu'un
  canal rempli jusqu'au plafond.

L'adresse n'est jamais conservée : `ip_ref` est le même condensé salé au jour
que `visitor_ref`, sans le user-agent.

La mesure a son équivalent (`event_ip_quota`), mais **en mémoire** : son chemin
ne fait aucune requête, et lui en donner une par visite défairait ce qui le fait
tenir. Il est donc approximatif, remis à zéro au redémarrage, et **illimité par
défaut**, pour qu'aucun site en place ne se mette à perdre des vues.

### La limite de l'offre, exacte sans requête par vue

Le quota `events` borne les vues et événements du **mois** (UTC), contre l'offre
du propriétaire de l'espace. Trois choses le rendent exact sans coûter une
requête par vue :

- le compte se lit une fois par minute et par espace : l'agrégat journalier pour
  les jours révolus, **les événements bruts pour aujourd'hui**. L'agrégat seul
  ne suffit pas, il n'est refait qu'au ménage horaire : une limite de 10 laissait
  passer tout ce qui arrivait dans l'heure ;
- entre deux lectures, l'ingestion **compte elle-même** ce qu'elle accepte,
  événement par événement, pour qu'un lot n'enjambe pas la limite ;
- une seule relecture tourne à la fois par espace, et l'ancien compte sert en
  attendant : quand il expire, mille vues simultanées ne lancent pas mille
  requêtes.

`audience.list` rend ce même compte (`eventsQuota`), lu en base et jamais dans la
mémoire de l'ingestion. L'écran en tire l'état « limite atteinte », sur la liste
comme sur la fiche, et un bandeau vers les offres. Pour qu'il change sans
recharger, l'ingestion prévient l'espace à la vidange qui suit le premier refus :
après, et non pendant, parce que les dernières vues acceptées ne sont en base
qu'à ce moment-là. Les retours des formulaires ne passent pas par ce quota.

### Les deux portes d'envoi, et la redirection

`POST /api/t/s` accepte deux formes de corps : le JSON de `deveye.submit` (ou
d'un `curl`, ou d'un serveur), et l'`application/x-www-form-urlencoded` d'un
`<form method="post">` sans une ligne de JavaScript. La seconde existe parce
que le cas visé est un site vraiment statique : lui imposer un bundle pour
recueillir un message serait rater la cible. Elle a demandé un analyseur de
corps de plus dans `src/app.ts` **et** `src/publicApp.ts`, un module ne pouvant
pas en enregistrer.

La règle du `204` du §3.2 tient, à deux exceptions près, et les deux sont des
choses que le site doit savoir :

- un **corps mal formé, ou qui ne colle pas aux questions déclarées**, rend
  `400` en nommant le champ fautif. Ce n'est pas un renseignement sur les clés
  qui existent, c'est une propriété de la requête envoyée, et le seul aveu
  qu'elle contient (« cette clé existe ») porte sur une clé publique, dans la
  page. Sans lui, un site qui vient de renommer un champ n'aurait aucun moyen
  de s'en apercevoir ;
- une **panne d'écriture** rend `503`. Répondre « reçu » quand l'écriture a
  échoué ferait annoncer au visiteur un message perdu, ce que l'écriture
  synchrone cherchait précisément à éviter. Le mince renseignement que cela
  donne à qui sonde ne vaut que le temps de la panne, moment où il n'y a de
  toute façon pas grand-chose d'autre qui tienne debout.

Tout le reste (clé inconnue, origine refusée, formulaire fermé ou plein, quota
atteint) rend le
même succès.

`_next` est confronté à l'en-tête `Origin` de l'envoi, **et à rien d'autre**.
S'appuyer sur les origines autorisées du site aurait deux défauts : faire de
cette route un redirecteur ouvert pour un site dont la liste est vide, et
distinguer les refus, un `_next` honoré disant que la clé est bonne. Sans
`Origin` (un `curl`, un appel serveur), aucune redirection.

## 6. Carte du code

Depuis le 28 août 2026, tout ce qui est propre à la feature vit dans le module
`DevEye/features/audience/` ; l'app ne garde que ce qui appartient à Projets
(la liaison) et l'infrastructure des routes publiques.

### Le module — `DevEye/features/audience/`

```
package.json, deveye-feature.json    deveye-feature-audience ; allowlist des 7 tables historiques
src/index.ts                         manifest + contrats (l'entrée isomorphe)
src/manifest.ts                      featureDescriptor('audience') étalé ; resources, routes.public, settings.item
src/contracts/domain.ts              site, plateforme, dimensions, mesures, charge d'ingestion, retours, lignes SQL
src/contracts/commands.ts            25 commandes, préfixe unique `audience.`
```

@deveye/types ne garde que l'**identité** (l'id dans les schémas d'espace, de
sujet live et de registre) et les **couplages déclarés** :
`AUDIENCE_ITEMS_PROVIDER` (serveur, lu par Projets avant de relier),
`AUDIENCE_CLIENT_PROVIDER` (client, composé par l'onglet d'un projet). La ligne
de liaison (`ProjectAudienceLinkRow`) vit chez Projets
(`features/projects/src/contracts/link.ts`, la table est à Projets).

### Serveur — `features/audience/src/server/`

```
index.ts        serverEntry : createRepo, features, migrationsDir, createService (ingestion + provider
                + publicRoutes), items
repo.ts         AudienceRepo sur SdkQueryable : les trois dépôts natifs en un contrat, sections gardées
                (sites et lectures agrégées : le chemin froid ; entonnoirs ; ingestion : le chemin chaud)
repoForms.ts    la section « retours » du même contrat, détachée : formulaires, soumissions, compteurs
migrations/     001_forms.sql — les 4 tables ft_audience_* des retours (les 7 autres datent du socle)
                002_forms_declared.sql — schéma déclaré, quotas, et « origines vides = rien »
_shared.ts      Ctx, StoredSite, nameRef, generatePublicKey, packOrigins/parseOrigins, loadSite,
                loadHomeSite, siteCipher, toSite(…, projectCount), rangeWindow, toMetrics,
                setIngest/ingestOf (le singleton), projectsProvider/projectCountsOf/projectUsageOf
crud.ts         count, list, get, siteAdd, siteUpdate, siteRotateKey, siteRemove, reorder
stats.ts        overview, breakdown, activity, live
funnels.ts      funnelList, funnelAdd, funnelUpdate, funnelRemove
forms.ts        formList, formAdd, formUpdate, formClear, formRemove, submissionList,
                submissionRemove, results
validate.ts     un envoi confronté aux questions déclarées, et converti (pur)
stats.ts        (aussi) summary : les trois cartes du sommaire, en un aller-retour
handlers.ts     l'agrégat des vingt-quatre commandes
service.ts      AudienceIngest sur FeatureServiceDeps : caches, file, lot, coalescence, ménage, sel dérivé ;
                submit() — la réception des retours, synchrone (§5 ter)
answers.ts      ce qu'on compte dans un retour (pur), et countAnswers qui l'applique
routes.ts       publicRoutes sur SdkPublicApp : GET /t.js · POST /api/t/b · POST /api/t/e · POST /api/t/s
script.ts       le script servi aux pages suivies, et son ETag
normalize.ts    chemins, hôtes, référents, condensés (pur)
userAgent.ts    navigateur / système / appareil (pur)
*.test.ts       handlers, forms, service, routes, answers, validate, normalize
                (harnais @deveye/types/sdk/testing)
```

Ce qui a changé de main au rapatriement, et pourquoi :

- **le dépôt ne connaît plus Projets** : `project_count`, `listUsage` et les
  liaisons ont quitté le module. Le compte et la liste des projets viennent du
  contrat `PROJECTS_USAGE_PROVIDER` (`projectCountsOf`, `projectUsageOf`), et
  `toSite` reçoit le compte en paramètre ; sans contrat, zéro projet partout,
  aucune commande ne casse ;
- **l'ingestion est un singleton du module** posé par `createService`
  (`setIngest`), lu par les handlers (`ingestOf()?.invalidate()`) : l'ex
  `ctx.audience` que le dispatcheur natif prêtait ;
- **le sel des visiteurs est dérivé** (`deps.keys.derive`), voir §2.4 ;
- **les routes publiques sont déclarées par le service** (`publicRoutes`), et
  c'est l'hôte qui les monte, sur chaque écouteur ;
- **`ingestOrigin()` est `ctx.origins.public`**, voir §3.0.

### Ce qui reste dans l'app — `DevEye/src/`

```
db/migrations/076_audience.sql             5 tables (historiques, allowlist du module)
db/migrations/077_project_audience_links.sql  la liaison (table de Projets)
db/migrations/078_audience_funnels.sql     entonnoirs et marches
db/migrations/079_audience_visitor_mode.sql   le mode de reconnaissance du visiteur
features/projects/src/server/repo/links.ts listSiteIds, linkSite, unlinkSite, unlinkAllSites,
                                           listSiteUsage, countSiteLinks (chez Projets)
features/projects/src/server/usageProvider.ts   l'entrée `audience` de PROJECTS_USAGE_PROVIDER
features/projects/src/server/audienceLink.ts    le pointeur d'un projet (existence par AUDIENCE_ITEMS_PROVIDER)
features/_sdk/register.ts                  modulePublicRoutes(app), isModulePublicPath(url)
features/_sdk/context.ts                   ctx.origins { app, public } (AUDIENCE_ORIGIN || PUBLIC_ORIGIN)
app.ts                                     le délégateur CORS (isModulePublicPath), modulePublicRoutes(app),
                                           les analyseurs text/plain et x-www-form-urlencoded
publicApp.ts                               le second écouteur : mêmes analyseurs, modulePublicRoutes(app)
Utils/Env.ts                               AUDIENCE_ORIGIN, PUBLIC_LISTEN_PORT (infrastructure)
```

### Client — `features/audience/src/client/`

```
index.tsx           clientEntry : Widget, Full, settingsPanels, providers
Audience.tsx        liste + fiche ; possède le niveau live `l1` (l'id du site)
api.ts              featureApi(manifest)
SiteList.tsx        les cartes + le glisser-déposer (useDragReorder)
SiteDetail.tsx      en-tête + sommaire + la section ouverte ; possède le niveau live `l2` (la section)
SiteHub.tsx         les trois cartes du sommaire (audience.summary)
SectionCard.tsx     la forme commune d'une carte du sommaire
SiteView.tsx        la fréquentation ⟵ partagée avec l'onglet d'un projet
Funnels.tsx         les entonnoirs ⟵ partagés avec l'onglet d'un projet
RangeBar.tsx        les cinq fenêtres, partagées par les blocs qui mesurent
Forms/Forms.tsx     les retours : sélecteur de formulaire, onglets Tableau / Résultats, export
Forms/SubmissionTable.tsx   le tableau (colonnes déduites, tri et recherche côté client)
Forms/SubmissionDialog.tsx  un retour brut, avec le contexte de sa visite
Forms/Results.tsx   la répartition des réponses, question par question
Forms/FormDialog.tsx  renommer, fermer, vider, supprimer un formulaire
Forms/export.ts     le CSV des retours chargés
SiteDialog.tsx      déclarer un site (nom, description, plateforme, origines) ; création seulement
SiteGeneralPanel.tsx  onglet Général : identité, plateforme, origines, collecte, suppression
SiteTrafficPanel.tsx  onglet Fréquentation : visiteurs, pages de transit, rétention, quota d'événements
SiteFormsPanel.tsx    onglet Retours : formulaires déclarés, création à la volée, quotas
FormEditor.tsx        déclarer un formulaire et ses questions typées
useSiteDraft.ts       le brouillon partagé des trois onglets (siteUpdate prend le site entier)
InstallDialog.tsx   contextuel (`scope`) : même forme partout (étape 1 le bloc à coller,
                    étape 2 ce qui est arrivé), contenu et mémo d'agent propres à la section,
                    la rotation de clé
FunnelDialog.tsx    définir un parcours à partir du déjà-observé
FunnelDetailDialog.tsx
Stats/{StatBand,TrendChart,Heatmap,TopList,FunnelBar,FunnelSteps}.tsx
AudienceWidget.tsx  format.ts  usage.ts  style.module.css
provider.tsx        AUDIENCE_CLIENT_PROVIDER : ce que l'onglet d'un projet compose
```

`features/projects/src/client/Audience/` se réduit à `Audience.tsx` (enveloppe
mince) et `LinkSiteDialog.tsx`, qui composent le contrat client du module par
`moduleClientProvider(AUDIENCE_CLIENT_PROVIDER)`. L'onglet **n'apparaît qu'à
partir du premier site relié** ; sans liaison, il repart dans le menu « + » de
la barre d'onglets, qui rouvre le même `LinkSiteDialog` (voir
[Projets](../projects/README.md) §2).

---

## 7. Pièges, et pourquoi ils existent

### Deux tuiles voisines ne peuvent pas porter le même pictogramme

L'icône était `activity`, celle de Monitoring. Sur la grille d'accueil, deux
tuiles côte à côte devenaient indiscernables — ce qui est exactement ce qu'on
demande à une grille d'icônes de ne pas faire. C'est `eye-open` : l'œil dit
« des vues », la courbe d'activité dit « une machine qui tourne ».

### `audience` voulait déjà dire autre chose

`FeatureAudience` désignait dans `Pages/Home/catalog.tsx` « à qui une tuile
d'accueil est destinée » — dans le fichier même où la nouvelle feature devait
s'enregistrer. Deux sens du mot à trois lignes d'écart, c'est la collision que
rien ne signale et qu'on paye six mois plus tard. L'ancien est devenu
**`HomeAudience`**, qui dit mieux ce qu'il est.

### Le filet de démarrage ne voit aucune commande de ce module

`MUTATION_VERB` cherche un verbe **juste après le point**. Les commandes d'ici
sont en camelCase sous un préfixe unique (`audience.siteAdd`) : il n'en verra
aucune, exactement comme pour git, les bases et les projets. → **Relire
`mutates` à la main.** En revanche, un préfixe absent de `COMMAND_PREFIX_TOPIC`
fait échouer le démarrage : c'est un contrat, pas une heuristique.

### Toute mutation d'un site doit invalider le cache de l'ingestion

`ingestOf()?.invalidate()` (le singleton posé par `createService`, l'ex
`ctx.audience`). Sans lui, un site qu'on vient d'éteindre continue
d'accepter des mesures pendant toute la vie du processus, et une clé qu'on vient
de renouveler laisse l'ancienne entrer — c'est-à-dire que la rotation ne sert à
rien, précisément dans le cas où on la demande. La panne est silencieuse : elle
se découvre en relisant des chiffres qu'on croyait arrêtés.

`audience.reorder` est la seule écriture qui **n'invalide pas**, et c'est juste :
l'ordre d'affichage n'entre dans aucune décision de l'ingestion.

### Le ménage des libellés était le seul coût non borné

La forme naturelle — `NOT EXISTS (… WHERE e.path_id = l.id OR …)` — est un piège :
la sous-requête est **corrélée**, donc rejouée pour chaque libellé, sur des
colonnes qu'aucun index ne couvre. Un site à trois cents libellés y parcourait
trois cents fois sa table de faits, toutes les heures.

La forme ensembliste (`NOT IN`, bornée par `site_id`) est matérialisée une fois,
et `idx_audience_events_window` porte `path_id` **et** `name_id` justement pour
la servir entièrement depuis l'index.

⚠️ `IS NOT NULL` dans chaque sous-requête n'est pas décoratif : `NOT IN` face à
un seul NULL ne rend **jamais** vrai, et le ménage ne supprimerait alors rien,
en silence et pour toujours.

Ce ménage n'est pas cosmétique : un site qui appelle `identify()` accumule un
libellé par utilisateur, qui survivrait à l'expiration de toutes ses sessions.

### La colonne qui n'a pas de `workspace_id`

`audience_labels` pend à son site, qui seul porte l'espace : pas de colonne
dupliquée sur une table qui grandit vite, une colonne dupliquée étant un second
endroit où la vérité peut diverger. Ce qui rattache un libellé à son espace se
retrouve par jointure sur `audience_sites`.

### La requête est retirée des chemins

`/produits?utm_source=x` compte comme `/produits`. Les garder ferait de chaque
paramètre une ligne de plus dans le classement, et « /produits » finirait
éparpillé sur trois cents entrées qui ne disent rien. Ce qu'on perd — la
provenance — est déjà porté par le référent, à sa place.

### L'ordre des tests de user-agent **est** le sujet

Presque tous mentent par héritage : Edge contient « Chrome », Chrome contient
« Safari », tout Android est un Linux et le dit. On va donc du plus spécifique au
plus général, et changer cet ordre casse la détection sans casser un seul test de
type.

---

## 8. Vérification

```bash
cd DevEye
npm run typecheck
npx tsc -p features/tsconfig.server.json --noEmit
DOTENV_CONFIG_PATH=.env.test npx tsx --test "features/audience/src/**/*.test.ts"
npx eslint features/audience/src/server features/audience/src/contracts features/audience/src/manifest.ts
```

**Vérifié hors serveur, par les tests committés du module** (harnais
`@deveye/types/sdk/testing`, dépôts en mémoire, aucune base ni réseau) :

- `handlers.test.ts` : les restrictions par élément (un site masqué disparaît
  de la liste et du compte), le partage inter-espaces (`foreign: true` sous le
  codec du domicile ; régler, renouveler, supprimer ou définir un entonnoir
  depuis la fenêtre est refusé), le contrat de Projets (`projectCount` et
  `usage` du provider, zéro sans provider), l'adresse de la balise
  (`ctx.origins.public`), les origines normalisées à l'écriture, la clé
  choisie par le serveur, le cache de l'ingestion vidé par toute mutation
  d'un site et par aucun réordonnancement, le ménage à la suppression
  (`items.forget`), et un entonnoir aux marches normalisées comme à
  l'ingestion, relu avec ses chiffres ;
- `service.test.ts` : un événement accepté entre en base à la vidange (session
  aux dimensions posées à l'ouverture, fait, site touché), une identité
  arrivée en route rattache la session ouverte, les refus (origine, `Origin`
  absent sur un site `web`, clé inconnue, robot, événement sans nom, site
  éteint) n'écrivent rien et ne diffusent rien, un site `app` accepte sans
  `Origin`, le direct est coalescé (deux vidanges, un battement par espace),
  `invalidate` fait relire un site que le cache tenait pour actif, le ménage
  agrège hier et aujourd'hui puis élague à la rétention et balaie les
  libellés orphelins, et le sel est demandé une fois à `deps.keys.derive`
  (un visiteur persistant est reconnu à l'identique par une seconde instance) ;
- `routes.test.ts` : les quatre routes déclarées, les trois POST avec leur
  plafond ; `/t.js` servi avec son type, son cache, son ETag et CORP, `304`
  sur ETag connu ; un lot valide atteint l'ingestion avec l'origine, le
  user-agent et l'adresse ; quatre corps invalides rendent le même `204` sans
  l'atteindre ; l'événement isolé passe, `Origin` absent compris ; et pour
  `/api/t/s`, les deux formes de corps, le pot de miel qui accepte sans rien
  écrire, le `400` du seul corps mal formé, le succès identique sur clé
  inconnue, et **le refus de rediriger vers un hôte autre que l'origine de
  l'envoi** (§5 ter) ;
- `forms.test.ts` : la frontière d'espace des retours (un formulaire projeté se
  lit mais ne se règle pas), la pagination par curseur `(ts, id)` qui ne boucle
  pas, le contexte de visite rendu quand la session existe et jamais inventé,
  le regroupement d'une répartition avec son seau de texte libre, le cache de
  l'ingestion vidé par chaque mutation, la **décrémentation exacte** à la
  suppression d'un retour, et le vidage en bloc qui laisse le canal ouvert ;
- `answers.test.ts` : les règles d'indexation d'un retour, celles-là mêmes que
  la suppression rejoue (choix multiple éclaté, nombre et booléen canoniques,
  seau au-delà de la longueur limite, question sans nom ignorée) ;
- `normalize.test.ts` : chemins, hôtes, référents, les trois règles
  d'`originAllowed`, la stabilité et la sensibilité des condensés, les jours
  UTC, l'ordre de détection des user-agents.

Ce que ces tests ne couvrent pas, et qui se vérifie sur un serveur monté :
le montage réel des routes par l'hôte (helmet compris : CORP `same-origin`
préservé ailleurs), les analyseurs `text/plain`, `application/json` et
`application/x-www-form-urlencoded`, le plafond de débit appliqué par Fastify,
le délégateur CORS, et la redirection `303` telle que le navigateur la suit
après un `<form>`. C'est le banc d'essai de la première version (ci-dessous),
à rejouer à chaque changement d'`app.ts` ou de `publicApp.ts`.

### Vérifié le 26 août 2026, sur une base

Aucune base n'était joignable pendant le chantier ; tout ce qui suit a été
exécuté ensuite, sur une base neuve migrée depuis le dépôt et sur la base de
dev qui porte déjà des données réelles.

- [x] **les migrations `076`, `077` et `078`** : jouées de zéro sur la base
      neuve, puis rejouées telles quelles une seconde fois sans erreur (elles
      sont idempotentes), et déjà passées sur la copie du dump.
- [x] **toutes les requêtes SQL** des trois dépôts (`audience.ts`,
      `audienceIngest.ts`, `audienceFunnels.ts`) : les 72 méthodes exercées sur
      un jeu synthétique avec des invariants de données (`activity` rend le bon
      jour et la bonne heure locale pour `tz_offset = -120`, `points` aligne ses
      seaux sur l'origine et retrouve toutes les vues, `returningVisitors` voit
      la visite de la veille, `retention` rend `[2, 1, 0]` avec une marche
      inconnue, `rollupDay` rejoué écrase sans doubler, `pruneOrphanLabels` ne
      retire que le libellé orphelin, `remove` ne laisse aucune ligne).
- [x] **le chemin de bout en bout** : serveur monté sur la base de dev,
      `/t.js` servi, un lot sur `/api/t/b` et un événement isolé sur `/api/t/e`
      acceptés (204), trois événements en base après le vidage de la file,
      `last_event_at` touché, deux sessions ouvertes (persistante et anonyme).
- [x] **l'interface** : le smoke de la feature (marché d'ajout, tuile, vue
      complète, allers-retours `audience.count` et `audience.list`, zéro
      exception JS).

### Points d'attention à l'essai manuel

1. **Installation** — la balise pose un événement ; l'écran passe de « en
   attente » à « première mesure reçue ».
2. **SPA** — une navigation `pushState` produit une seconde vue et **une seule**
   session ; deux `replaceState` sur la même route n'en produisent qu'une.
3. **Origines** — `curl` sans `Origin` sur un site `web` : refusé, `204`, rien en
   base. Sur un site `app` : accepté. Clé inconnue : `204` indistinguable.
4. **Extinction** — site éteint, plus rien n'entre ; l'historique reste.
5. **Rotation** — l'ancienne clé cesse d'être acceptée **immédiatement**, sans
   redémarrage.
6. **Direct, à deux navigateurs** — une visite chez l'un fait bouger le compteur
   chez l'autre **dans la minute**, sur la liste, la fiche et l'onglet du projet.
   Et pas plus souvent.
7. **Droits** — un rôle sans `audience` : tuile désaturée, `handleExpand` refuse,
   l'onglet d'un projet en « accès restreint ». ⚠️ _Fail-closed_ : les rôles
   existants ne l'accordent pas.
8. **Confidentialité** — passer un projet en confidentiel retire ses liaisons ;
   les sites survivent.
9. **Entonnoir** — le composer depuis les suggestions, vérifier que la première
   marche vaut le nombre d'entrées et que la dernière vaut les conversions ;
   ajouter une marche inexistante et vérifier qu'elle affiche zéro sans erreur ;
   supprimer l'entonnoir et le recréer à l'identique — **les chiffres doivent
   être exactement les mêmes**, c'est la preuve qu'il ne collecte rien.

---

## 9. Ce qui n'est pas fait

- **Pas de propriétés sur un événement.** La variante doit entrer dans le nom
  (`tarif-choisi-studio` plutôt que `tarif-choisi` + `{plan}`). C'est la limite
  qui se fait sentir en premier à l'usage.
- **Pas de temps de conversion** — on sait combien passent une marche, pas
  combien de temps ils mettent.
- **Pas de pays** — il faudrait embarquer une base GeoIP et la tenir à jour. Les
  fuseaux répondent à la même question à moindres frais.
- **Aucune notification à l'arrivée d'un retour.** C'est le manque qui se fera
  sentir en premier sur un formulaire de contact. Il fait basculer le module en
  `notifies: true`, ce qui touche le registre publié, demande la capacité
  `notify`, un onglet Notifications et le câblage des canaux : un chantier à
  part, pas une ligne à ajouter.
- **Aucune validation des retours.** DevEye range ce qu'on lui envoie ; le site
  seul connaît son formulaire, et un schéma imposé ici se serait trompé.
- **Le tri et la recherche du tableau portent sur les lignes chargées**, jamais
  sur tout le formulaire : la charge utile est chiffrée, la base n'a rien à quoi
  appliquer un `ORDER BY` ni un `LIKE`. L'écran le dit sous le tableau.
- **Pas de package npm ni de module React Native** — la balise couvre les pages
  web et les projets React ; le contrat d'ingestion est déjà neutre (§3.5).
- **Pas de visiteurs récurrents** — conséquence directe du sel tournant (§2.4).
- **Perte d'une seconde d'événements** sur un arrêt brutal (§3.3).
- **Rien ne borne la cardinalité des libellés.** Qui connaît la clé d'un site et
  se trouve sur une origine autorisée peut envoyer des chemins tirés au sort et
  faire grossir `audience_labels`. Le plafond de débit par IP et la liste
  d'origines sont les seules gardes ; le ménage horaire finit par rendre la
  place, mais seulement une fois les faits expirés. Un plafond de libellés par
  site serait le correctif, il n'est pas écrit.
- **Le direct reste local au processus** — deux instances derrière un proxy =
  salles silencieusement séparées. Vrai avant ce module, ça le reste.
- **Le domaine public reste à créer.** Le code fournit le port dédié
  (`PUBLIC_LISTEN_PORT`) ; il reste à pointer un domaine dessus dans le proxy et
  à accorder `AUDIENCE_ORIGIN`.
