# Audience — le suivi d'usage des projets livrés

> Écrit le 13 août 2026, à la fin du chantier qui l'a introduite ; relu le
> 21 août 2026. Compagnon de [PROJECTS.md](./PROJECTS.md) : celui-ci suit le
> travail, [GIT.md](./GIT.md) suit le code, celui-là suit **ce que les gens en
> font**. Il dit *pourquoi* ; le code dit comment.
>
> Depuis : les sites se **partagent entre espaces** comme les autres éléments
> de premier rang (`SHARING.md`), et la fiche d'un site porte le bouton de
> réglages commun (partage, permissions par rôle : `SETTINGS.md`).

DevEye savait piloter le travail, suivre le code, surveiller l'infra — mais rien
ne disait ce que les visiteurs faisaient des projets une fois livrés. Il
manquait la boucle de retour.

Documents voisins à respecter : [WORKSPACES.md](./WORKSPACES.md),
[LIVE.md](./LIVE.md), [DATABASES.md](./DATABASES.md),
[SECURITY_MODEL.md](./SECURITY_MODEL.md).

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
[PROJECTS.md](./PROJECTS.md) §1.2 autorise explicitement. Ils sont de toute
façon publics : la balise les expose dans le HTML de chaque page suivie.

### 2.4 Aucun cookie, aucun identifiant persistant

`visitor_ref = sha256(sel du jour + clé du site + IP + user-agent)`, tronqué à
16 caractères. **Ni l'IP ni le user-agent ne sont stockés** ; le sel est dérivé
d'un secret serveur et de la date UTC.

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
(`audience.get`). La déduire de `window.location.origin` — ce que faisait la
première version — donnait une balise juste en développement et **fausse en
production** : l'application vit derrière le VPN, l'ingestion doit être joignable
sans lui, donc les deux adresses diffèrent par construction.

En développement sur l'hôte, le client est servi par Vite sur `:5173` : `/t.js`
est donc aussi **proxifié** dans `client/vite.config.ts`, à côté de `/api` et
`/ws`. Sans cette entrée, Vite cherche le script parmi ses propres fichiers et
rend un 404 — la balise semble cassée alors que le serveur la sert parfaitement.

### 3.0 bis Un second écouteur, et non une garde

L'application vit derrière le VPN ; l'ingestion doit être joignable sans lui.
Trois façons d'y arriver, et deux sont moins sûres :

| Approche | Ce qui la sépare du monde |
|---|---|
| Règle de chemin dans le proxy | une configuration hors dépôt, qu'un redéploiement peut perdre |
| Garde sur l'en-tête `Host` | un `if`, avec les routes internes toujours déclarées derrière |
| **Second écouteur** | **rien à séparer : les routes internes n'y sont pas enregistrées** |

C'est la troisième. `PUBLIC_LISTEN_PORT` démarre un serveur qui ne déclare que
`/t.js`, `/api/t/b`, `/api/t/e` et une sonde de vivacité. Il n'existe aucun
chemin de code de ce port vers l'authentification, la socket, la flotte
d'appareils ou le client web. Ni cookies, ni WebSocket, ni fichiers statiques,
ni repli SPA n'y sont montés.

Vide, il n'y a pas de second serveur et les routes publiques restent sur le port
principal : c'est le cas du développement, et celui d'une installation qui n'a
pas besoin de la séparation.

⚠️ **`trustProxy` doit rester actif sur ce second écouteur.** Le plafond de
débit compte par IP ; sans lui il verrait celle du proxy, et le premier visiteur
un peu actif fermerait la porte à tous les autres.

**Même processus, et c'est une contrainte.** `AudienceIngest` prévient les
écrans par `LiveHub`, dont l'état est local au processus ([LIVE.md](./LIVE.md)
§6). Un conteneur séparé écrirait les mesures sans que personne ne soit averti :
le rafraîchissement à la minute cesserait de fonctionner, **silencieusement**.
Partager le processus, c'est partager la file, les caches et le hub.

### 3.1 Trois obstacles dans le socle, trois réponses

1. **Le CORS était global** sur `PUBLIC_ORIGIN`. Il est désormais **délégué par
   requête** : `*` sans identifiants pour `/api/t/*` et `/t.js`, `PUBLIC_ORIGIN`
   avec cookies partout ailleurs. Le délégateur est la seule forme qui reçoive
   la requête.
2. **Le plafond de débit global** (200/min) est dimensionné pour une interface
   humaine ; les routes d'ingestion ont le leur (600/min par IP). La clé du site
   n'entre pas dans la clé de comptage : le plafond s'applique **avant** que le
   corps ne soit analysé.
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
requis, `path` désigne une route *ou* un écran, les trois champs d'appareil
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

| Vue | Contenu |
|---|---|
| **Sites** | tous les sites de l'espace, visiteurs et vues sur 24 h, état, nombre de projets |
| **Un site** | bandeau (vues, visiteurs, visites, durée, rebond) avec **écart à la période précédente** · courbe · top pages et provenances · navigateurs / systèmes / appareils · carte jour × heure · fuseaux · événements · utilisateurs |
| **Installer** | la balise à copier, et l'état « première mesure reçue » |
| **Onglet d'un projet** | les sites reliés, même `SiteView` |

Trois décisions d'écran qui méritent d'être connues :

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

Les graphes sont du **SVG écrit à la main**, `viewBox` fixe, sans
`ResizeObserver` — le patron d'`UptimeChart`. Aucune dépendance de graphes n'a
été ajoutée : le client n'en avait pas, et n'en voulait pas.

---

## 5. Le direct

**Deux régimes, et c'est la distinction qui compte.**

- Les mutations d'un humain (déclarer un site, le régler, renouveler sa clé, le
  supprimer) gardent `mutates` : instantanées, sous le plancher de 200 ms du hub.
- Le **flux d'ingestion** est coalescé à **une diffusion par minute et par
  espace**, dans `AudienceIngest`. Diffuser par événement ferait re-solliciter
  l'écran de tous les membres à chaque visite.

⚠️ **Ne pas déplacer cette coalescence dans le hub.** `TOPIC_FLOOR_MS` (200 ms)
doit rester strictement sous l'anti-rebond client de 250 ms, sinon on ouvre une
fenêtre d'écritures jamais vues ([LIVE.md](./LIVE.md) §4). Les deux valeurs
n'ont rien à voir : l'une est un invariant du moteur, l'autre un choix de
produit.

`LiveHub.changed()` ne fait déjà rien quand la salle est vide : personne ne
regarde, rien ne part. Il n'y avait donc pas de seconde garde à écrire.

**Le sujet `audience` invalide les quatre clés d'un coup** — `count`, `list`,
`detail`, `stats`. C'est délibéré : ce battement doit rafraîchir *tout* ce qui
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

> Une visite atteint la marche *i* si la **première occurrence** de chacune des
> marches 1..*i* s'est produite **dans l'ordre**.

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

## 6. Carte du code

### Contrats — `DevEye-Types/src/`

```
domain/audience.ts     site, plateforme, dimensions, mesures, charge d'ingestion
features/audience.ts   12 commandes, préfixe unique `audience.`
features/project.ts    project.audienceList / audienceLink / audienceUnlink
domain/workspaceRole.ts  le droit `audience` (le sujet live en découle)
```

### Serveur — `DevEye/src/`

```
db/migrations/076_audience.sql             5 tables
db/migrations/077_project_audience_links.sql  la liaison
db/migrations/078_audience_funnels.sql     entonnoirs et marches
db/repos/audience.ts                       le chemin **froid** : écrans, agrégats
db/repos/audienceIngest.ts                 le chemin **chaud** : ce que l'ingestion écrit
Services/AudienceIngest.ts                 caches, file, lot, coalescence, ménage
Services/audience/normalize.ts             chemins, hôtes, référents, condensés — pur
Services/audience/userAgent.ts             navigateur / système / appareil — pur
audience/routes.ts                         POST /api/t/b · /api/t/e · GET /t.js
audience/script.ts                         le script servi aux pages suivies
db/repos/audienceFunnels.ts                 définitions + la rétention ordonnée
features/audience/{_shared,crud,stats,funnels}.ts
features/project/audienceLink.ts           le pointeur d'un projet
```

Les deux dépôts touchent les mêmes tables et sont séparés exprès : l'un sert des
écrans quelques fois par minute, l'autre écrit à la cadence des visites de tous
les sites de tous les espaces. Les mélanger aurait fait cohabiter des requêtes
qu'on optimise et des requêtes qu'on écrit pour être lues.

### Client — `DevEye/client/src/Features/Audience/`

```
index.tsx         liste + fiche ; possède le niveau live `l1` (`site:<id>`)
SiteList.tsx      les cartes + le glisser-déposer (src/dragReorder.ts)
SiteDetail.tsx    en-tête, SiteView, projets liés
SiteView.tsx      ⟵ le cœur partagé avec l'onglet d'un projet
SiteDialog.tsx    déclarer / régler / supprimer
InstallDialog.tsx la balise, l'état « première mesure », la rotation de clé
FunnelDialog.tsx  définir un parcours à partir du déjà-observé
Stats/{StatBand,TrendChart,Heatmap,TopList,Funnel}.tsx
AudienceWidget.tsx  format.ts  style.module.css
```

`Features/Projects/Audience/` se réduit à `Audience.tsx` (enveloppe mince) et
`LinkSiteDialog.tsx`. L'onglet **n'apparaît qu'à partir du premier site relié** ;
sans liaison, il repart dans le menu « + » de la barre d'onglets, qui rouvre le
même `LinkSiteDialog` — voir [PROJECTS.md](./PROJECTS.md) §2.

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

`ctx.audience?.invalidate()`. Sans lui, un site qu'on vient d'éteindre continue
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

### Les deux listes de rekey, et la colonne qui n'a pas de `workspace_id`

`audience_labels` pend à son site, qui seul porte l'espace. `workspaceRekey` a
donc gagné un second mode de portée (`audience_site`, par sous-requête) plutôt
qu'une colonne dupliquée sur une table qui grandit vite — une colonne dupliquée
est un second endroit où la vérité peut diverger.

L'oublier n'aurait rien cassé de visible tout de suite : les nombres seraient
restés justes, et chaque classement se serait vidé de ses intitulés. C'est la
pire des deux pannes — silencieuse, et découverte des semaines plus tard.

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
./ci.sh
rsync -a --delete DevEye-Types/src/ DevEye/node_modules/deveye-types/src/
diff -rq DevEye-Types/src DevEye/node_modules/deveye-types/src   # doit être vide
```

**Vérifié hors serveur — les routes** (35 assertions, `tsx` + `app.inject()`, sur
le montage réel de `app.ts` — **helmet compris** — avec un service bouchonné) :
`Cross-Origin-Resource-Policy: cross-origin` sur les trois routes publiques et
`same-origin` préservé partout ailleurs (assertion éprouvée en retirant le
correctif) ; `/t.js` sert son type,
son cache, son ETag et un `304` sur ETag connu ; un lot `text/plain` — la forme
qu'émet `sendBeacon` — est bien analysé, avec origine et user-agent transmis ;
`application/json` marche aussi (curl, client serveur) ; l'événement isolé
passe ; **cinq formes de refus rendent toutes `204` sans que rien n'atteigne le
service** (corps vide, JSON cassé, clé trop courte, lot vide, type inconnu) ; le
préalable CORS d'une origine quelconque est accepté sur l'ingestion, et une
route ordinaire reste sur `PUBLIC_ORIGIN` avec ses identifiants — le délégateur
ne laisse pas fuiter son `*`.

**Vérifié hors serveur — les entonnoirs** (32 assertions, `tsx`, avec un
`Queryable` qui n'exécute rien et retient ce qu'on lui demande) : la requête de
rétention porte **autant de marqueurs que de paramètres, dans le bon ordre** —
le piège le plus probable du module ; un chemin lit `path_id` et un événement
`name_id` ; la chaîne de conditions cumule bien les marches précédentes ; une
marche jamais émise coupe la construction et met des zéros jusqu'au bout ; une
première marche absente n'émet aucune requête ; `COALESCE` ramène à zéro un
`SUM` sur zéro visite ; les libellés sont indexés sur `kind:ref` (le même texte
peut être un chemin **et** un événement) ; et la désignation de la marche qui
bloque le plus, égalités et entonnoirs vides compris.

**Vérifié hors serveur — la logique pure** (85 assertions, `tsx`, sur les
fonctions livrées et non des copies) : normalisation des chemins (requête, ancre, barre finale, URL
complète, URL illisible tolérée), des hôtes (protocole, port, chemin, IPv6) et
des référents (interne ignoré) ; les trois règles d'`originAllowed` sur les trois
plateformes ; la stabilité du condensé de visiteur et sa sensibilité à chacun de
ses quatre champs, séparateurs compris ; les bornes de jour ; l'ordre de
détection des user-agents (Edge avant Chrome, Chrome avant Safari, Android avant
Linux, tablette Android sans « Mobile ») ; l'alignement des cinq fenêtres sur
leur propre pas ; et les moyennes sur zéro session.

### Ce qui n'a pas pu être vérifié, et il faut le faire

**Aucune base MySQL n'était joignable** sur la machine de développement au moment
du chantier (ni serveur local, ni conteneur, ni dump dans `Backups/`). N'ont donc
**jamais tourné** :

- [ ] **les migrations `076`, `077` et `078`** — à rejouer deux fois sur une copie du
      dump de production avant livraison, en vérifiant des invariants de
      **données** et non seulement le succès du DDL. Elles tournent au démarrage,
      hors transaction, et ne sont jamais rejouées ;
- [ ] **toutes les requêtes SQL** de `db/repos/audience.ts` et
      `db/repos/audienceIngest.ts` — écrites avec soin, jamais exécutées. À
      essayer en premier : `activity()` (arithmétique de fuseau et `MOD`),
      `points()` (alignement des seaux), `pruneOrphanLabels()` (le `NOT IN`) et
      l'upsert `resolveLabel` ;
- [ ] **le chemin de bout en bout** : balise → `/api/t/b` → file → lot → écran.
      Les deux extrémités sont vérifiées séparément (routes ci-dessus, logique
      pure ci-dessus) ; c'est le milieu — la file, le lot, les caches — qu'aucune
      exécution n'a traversé ;
- [ ] **l'interface**, qu'aucun navigateur n'a affichée.

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
   l'onglet d'un projet en « accès restreint ». ⚠️ *Fail-closed* : les rôles
   existants ne l'accordent pas.
8. **Confidentialité** — passer un projet en confidentiel retire ses liaisons ;
   les sites survivent.
9. **Rekey** — `workspace.enableSharedKey` sur un espace portant des sites : nom,
   libellés, entonnoirs et marches toujours lisibles après conversion.
10. **Entonnoir** — le composer depuis les suggestions, vérifier que la première
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
  (`PUBLIC_LISTEN_PORT`) ; il reste à pointer un domaine dessus dans Dokploy et
  à accorder `AUDIENCE_ORIGIN`. Le conteneur est déjà sur `dokploy-network`,
  donc rien à changer au `docker-compose`.
