# Audience : le suivi d'usage des sites livrés

Audience mesure ce que les visiteurs font des sites qu'un espace a livrés
(pages vues, événements nommés, provenances, appareils, entonnoirs) et reçoit
ce qu'ils écrivent dans ses formulaires. C'est le compagnon de
[Projets](../projects/README.md), qui suit le travail, et de
[Git](../git/README.md), qui suit le code : celui-ci suit l'usage.

Documents voisins : [Docs/WORKSPACES.md](../../Docs/WORKSPACES.md),
[Docs/LIVE.md](../../Docs/LIVE.md), [Docs/SHARING.md](../../Docs/SHARING.md),
[Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md),
[Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md).

---

## 1. Le modèle

### 1.1 Un site est un objet de l'espace

Un **site suivi** appartient à l'espace. Plusieurs projets peuvent suivre le
même, certains sites ne servent aucun projet, et un projet n'en garde qu'une
**liaison** (`project_audience_links`, PK composite, FK en `CASCADE`, table de
Projets). Même forme que les dépôts, les services surveillés et les bases : des
objets d'espace, pas des propriétés d'un projet.

Les sites se **partagent entre espaces** comme les autres éléments de premier
rang (`shareTier: 'open'`, [Docs/SHARING.md](../../Docs/SHARING.md)) : un site
projeté se lit depuis l'espace qui le reçoit, mais se règle, se renouvelle et
se supprime seulement depuis son domicile. La fiche d'un site porte le bouton
de réglages commun (onglets Général, Fréquentation, Retours, puis Partage et
Permissions : [Docs/SETTINGS.md](../../Docs/SETTINGS.md)).

### 1.2 Toujours à l'étage ouvert

**L'ingestion tourne sans session**, depuis une requête HTTP anonyme émise par
un navigateur qui ne connaît pas DevEye. Seul l'étage ouvert du chiffrement
(`open_dek_wrapped`) se relit sans mot de passe, donc tout ce que le module
chiffre l'est à cet étage. Conséquences :

- rien ici ne demande jamais de mot de passe ;
- **un projet confidentiel ne peut pas suivre de site**, et le passer en
  confidentiel délie les siens (les sites, eux, survivent).

### 1.3 Une statistique est un `GROUP BY`, donc rien de ce qu'on agrège n'est chiffré

C'est le nœud du module. Le chiffrement est non déterministe : deux chiffrés du
même libellé diffèrent, et aucun `GROUP BY` ne peut porter dessus. La sortie
est une **table de dimensions** :

```
audience_labels    site_id, kind, label_ref, content          ← le libellé chiffré, une fois
audience_sessions  site_id, visitor_ref, started_at, last_at, views, *_id (dimensions), tz_offset, screen_width
audience_events    site_id, session_id, ts, kind, path_id, name_id
audience_daily     site_id, day, views, events, sessions, visitors   ← jamais purgé
```

Un chemin vu mille fois est stocké **une** fois ; les tables de faits ne portent
que son identifiant entier. On agrège sans clé, et l'on ne déchiffre que les
quelques dizaines de libellés qu'un écran affiche réellement.

**Une seule table de dimensions** discriminée par `kind` (les valeurs
d'`audienceDimensionSchema`), et non une par axe : une ligne de rekey au lieu
de dix, un seul cache, un seul chemin de résolution.

### 1.4 Ce qui reste en clair

`public_key`, `origins`, `active`, `platform`, `visitor_mode`, les quotas et la
rétention : exactement les champs dont l'ingestion a besoin pour **router une
requête sans session ni clé**. La clé et les origines sont de toute façon
publiques, la balise les expose dans le HTML de chaque page suivie. Le nom, la
description et les pages de transit sont chiffrés dans `content`.

### 1.5 Le visiteur : anonyme par défaut, persistant sur demande

Par défaut, **aucun cookie ni identifiant** n'est posé chez le visiteur :
`visitor_ref = sha256(sel du jour + clé du site + IP + user-agent)`, tronqué à
16 caractères. **Ni l'IP ni le user-agent ne sont stockés.** Le sel est dérivé
d'un secret serveur et de la date UTC ; ce secret est une clé dérivée de la clé
serveur par le SDK (`deps.keys.derive('audience', 'visitor-salt', 32)`, HKDF,
jamais stockée), stable d'un redémarrage à l'autre tant que la clé serveur ne
change pas. Trois conséquences :

- rien à faire accepter par un bandeau de consentement ;
- un même visiteur n'est **pas** reconnaissable d'un jour à l'autre, donc pas
  de visiteurs revenus ;
- la clé du site entre dans le condensé, donc croiser les audiences de deux
  sites est mécaniquement impossible.

Un site peut activer un **mode persistant**, et il faut le vouloir des deux
côtés : le réglage du site (`audience_sites.visitor_mode = 'persistent'`,
onglet Fréquentation) **et** l'attribut `data-visitor="persistent"` sur la
balise. La balise range alors un identifiant tiré au sort dans `localStorage`
(`deveye:v:<clé>`), que le serveur condense avec la clé du site
(`persistentVisitorRef`). C'est lui seul qui rend les visiteurs revenus
comptables (`repo.returningVisitors`). Ranger un identifiant durable chez le
visiteur **relève du consentement, comme un cookie** : la directive ePrivacy ne
distingue pas les deux, et l'onglet Fréquentation l'affiche comme un
avertissement, c'est au site de le recueillir. Sans l'attribut, rien n'est
posé ; sans le réglage, le serveur ignore l'identifiant ; un stockage refusé
(navigation privée) retombe sur la mesure anonyme. Un client natif (site
`app`) obtient la même chose en envoyant un `visitorId` stable avec chaque lot.

Le « par qui » nominatif vient d'ailleurs, et seulement si le site le veut : un
`identity` que **lui** envoie pour ses propres utilisateurs connectés
(`deveye.identify`).

### 1.6 Les droits

Les statistiques ne portent rien de nominatif ; les retours des formulaires,
si (noms, adresses, textes libres). Le manifest déclare donc deux ressources de
permission (`extraPermissions`, [Docs/PERMISSIONS.md](../../Docs/PERMISSIONS.md)) :

- **Retours des formulaires** (`submissions`) : lire les messages reçus et les
  supprimer. Sans ce droit, le rôle voit toutes les statistiques et la section
  Retours reste fermée ;
- **Exporter les retours** (`submissionsExport`) : télécharger le CSV. Demande
  le droit précédent. C'est un garde-fou d'interface, pas une frontière.

Une restriction par élément porte l'espace depuis lequel elle s'applique : un
site partagé à trois équipes n'ouvre ses retours qu'à celles à qui on les
accorde.

---

## 2. L'ingestion : la porte d'Audience ouverte sur Internet

### 2.1 L'adresse vient de l'environnement, jamais du navigateur

`AUDIENCE_ORIGIN` (à défaut `PUBLIC_ORIGIN`) porte l'adresse par laquelle les
pages suivies atteignent l'ingestion, et c'est le serveur qui la rend au client
(`audience.get` rend `ingestOrigin`, lu dans `ctx.origins.public` : le contexte
du SDK porte `{ app, public, site }` pour tous les modules, aucun ne lit la
variable). La déduire de `window.location.origin` donnerait une balise juste en
développement et **fausse dès que les deux adresses diffèrent** : l'ingestion
peut avoir son propre domaine, jusqu'à être la seule partie de l'instance
exposée.

En développement sur l'hôte, le client est servi par Vite : `/t.js` est donc
aussi **proxifié** dans `client/vite.config.ts`, à côté de `/api` et `/ws`.
Sans cette entrée, Vite cherche le script parmi ses propres fichiers et rend un 404.

### 2.2 Un second écouteur, et non une garde

L'ingestion doit être joignable par n'importe qui, sans compte ; rien d'autre de
l'instance n'a à l'être, et elle peut même rester privée. Trois façons de
séparer les deux :

| Approche                      | Ce qui la sépare du monde                                          |
| ----------------------------- | ------------------------------------------------------------------ |
| Règle de chemin dans le proxy | une configuration hors dépôt, qu'un redéploiement peut perdre      |
| Garde sur l'en-tête `Host`    | un `if`, avec les routes internes toujours déclarées derrière      |
| **Second écouteur**           | **rien à séparer : les routes internes n'y sont pas enregistrées** |

C'est la troisième. `PUBLIC_LISTEN_PORT` démarre un serveur (`src/publicApp.ts`)
qui ne déclare que les **routes publiques des modules** (`modulePublicRoutes`,
capacité `routes.public` : pour Audience `/t.js`, `/api/t/b`, `/api/t/e` et
`/api/t/s` ; Uptime y monte ses pages de statut, Projets ses pages publiques,
et tout module qui déclare la capacité) et une sonde de vivacité. Il n'existe
aucun chemin de code de ce port vers l'authentification, la socket, la flotte
d'appareils ou le client web. Ni cookies, ni WebSocket, ni fichiers statiques,
ni repli SPA n'y sont montés.

Vide, il n'y a pas de second serveur et les routes publiques restent sur le
port principal : c'est le cas du développement, et celui d'une installation qui
n'a pas besoin de la séparation.

**`trustProxy` est actif sur ce second écouteur** (`TRUST_PROXY`, comme sur le
principal). Le plafond de débit compte par IP ; sans lui il verrait celle du
proxy, et le premier visiteur un peu actif fermerait la porte à tous les
autres.

**Même processus, et c'est une contrainte.** Le service du module
(`AudienceIngest`) prévient les écrans par `deps.live.changed`, donc par le hub
du direct, dont l'état est local au processus
([Docs/LIVE.md](../../Docs/LIVE.md)). Un conteneur séparé écrirait les mesures
sans que personne ne soit averti. Partager le processus, c'est partager la
file, les caches et le hub. C'est aussi pourquoi le second écouteur monte les
routes des services **déjà créés** par `buildApp` : le module déclare les mêmes
routes sur chaque écouteur, c'est l'écouteur qui change, pas l'ingestion.

### 2.3 Trois gardes du socle, adaptées à une porte publique

1. **Le CORS est délégué par requête** : `*` sans identifiants pour les chemins
   publics que les modules ont déclarés (`isModulePublicPath`, alimenté par
   tout chemin public déclaré par un module), `PUBLIC_ORIGIN` avec cookies
   partout ailleurs. Le délégateur est la seule forme qui reçoive la requête.
2. **Le plafond de débit global** (`RATE_LIMIT_MAX`) est dimensionné pour une
   interface humaine ; les routes d'ingestion ont le leur : 600/min par IP sur
   `/api/t/b` et `/api/t/e`, 30/min sur `/api/t/s` (le `rateLimit` que le
   module pose sur chaque POST). La clé du site n'entre pas dans la clé de
   comptage : le plafond s'applique **avant** que le corps ne soit analysé. Les
   corps sont bornés aussi (64 Kio pour un lot, 8 Kio pour un événement isolé,
   256 Kio pour un retour).
3. **La clé de site est publique** et ne protège rien. Ce qui filtre, c'est la
   liste d'**origines autorisées** par site, confrontée à l'en-tête `Origin`
   côté serveur, là où un client ne peut pas mentir. Le CORS, lui, est un
   mécanisme que le navigateur applique à lui-même : ce n'est pas une garde.

### 2.4 Toujours `204`

Clé inconnue, origine refusée, site éteint, robot (`looksLikeBot`), charge
utile invalide, quota atteint : même réponse. Un endpoint public qui distingue
ses refus est un **oracle** : il dirait à qui le sonde quelles clés existent,
et laquelle vient d'être révoquée. Les deux exceptions de `/api/t/s` sont au
§6.

### 2.5 La requête ne touche pas la base

`accept()` résout le site depuis un cache mémoire, condense le visiteur, et
range dans une file. L'écriture a lieu **une fois par seconde, en lot**
(`FLUSH_MS`). Une visite rattache ses vues à la session ouverte du même
visiteur si la précédente date de moins de 30 minutes
(`AUDIENCE_SESSION_GAP_SECONDS`).

Le prix : **une seconde d'événements est perdue** si le processus tombe entre
deux vidanges. C'est de l'analytique, pas de la comptabilité, et la garantie
inverse coûterait un aller-retour SQL synchrone à chaque page vue de chaque
site.

La file est **bornée** (`QUEUE_MAX`, 20 000). Au-delà, on jette et on le
journalise : une base indisponible ne doit pas transformer la mémoire du
processus en file sans fond.

### 2.6 CORP : un 200 parfait que le navigateur jette

`@fastify/helmet` pose `Cross-Origin-Resource-Policy: same-origin` sur
**toutes** les réponses du serveur. C'est le bon défaut pour une application,
et c'est exactement ce qu'il ne faut pas sur `/t.js`, dont l'objet est d'être
chargé depuis ailleurs.

La panne ne ressemble à rien de connu : le serveur répond `200`, la réponse
arrive complète, puis le navigateur la jette avec
`ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. **Aucun en-tête CORS n'est en cause** :
un `<script src>` est une requête `no-cors`, et c'est là que CORP s'applique.

Les quatre routes publiques posent donc `Cross-Origin-Resource-Policy:
cross-origin`. Sur l'ingestion c'est une précaution (ses requêtes sont en mode
`cors`, hors du champ de CORP), mais rien ne garantit qu'un client futur les
émettra de la même façon.

### 2.7 `text/plain`, et ce n'est pas un détail

`navigator.sendBeacon` avec un `Blob` de type `text/plain` produit une requête
**simple** au sens CORS : aucune requête préalable `OPTIONS`. C'est ce qui fait
tenir la mesure en un aller simple depuis une page tierce. D'où l'analyseur de
contenu `text/plain` porteur de JSON dans `src/app.ts` et `src/publicApp.ts`,
un module ne pouvant pas en enregistrer.

### 2.8 Les clients natifs

Le contrat d'ingestion ne suppose **rien du navigateur** : aucun champ web n'est
requis, `path` désigne une route _ou_ un écran, les trois champs d'appareil
peuvent être renseignés explicitement par un client qui les connaît, et `at`
permet de livrer ce qu'on a mis de côté hors ligne (borné aux dernières 24 h
côté serveur : une horloge fausse ne doit pas dater une visite de 2038).

`audience_sites.platform` (`web` | `app` | `both`) décide si l'`Origin` est
confronté : un binaire natif n'en envoie aucun, et refuser son absence lui
fermerait la porte pour de bon. La clé d'un site `app` est extractible du
binaire, et seuls elle et le plafond de débit le protègent : il n'existe pas
mieux sans imposer un compte à chaque visiteur.

### 2.9 La balise

`/t.js` est servi tel quel, sans minification et avec ses commentaires : c'est
le seul morceau de DevEye qu'un tiers lira dans son propre navigateur. Il pose
une vue à l'ouverture puis une par changement de route (`pushState`,
`replaceState`, `popstate` ; deux vues identiques d'affilée n'en font qu'une),
offre `window.deveye.view / event / identify / submit / flush`, groupe ses
envois sur une demi-seconde et vide la file par `sendBeacon` quand l'onglet
part. Sur `localhost` il ne mesure rien, sauf `data-local="true"` ;
`data-manual="true"` coupe les vues automatiques. Deux balises sur la même page
n'en font qu'une. Le script est mis en cache une heure, avec un ETag.

---

## 3. Ce que ça donne à l'usage

| Vue                    | Contenu                                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sites**              | tous les sites de l'espace, visiteurs et vues sur 24 h, état, nombre de projets                                                                                                                                                                                            |
| **Un site**            | sommaire (fréquentation, entonnoirs, retours, courbe des sept jours) puis la section ouverte : bandeau avec **écart à la période précédente**, courbe, top pages et provenances, navigateurs / systèmes / appareils, carte jour × heure, fuseaux, événements, utilisateurs |
| **Installer**          | un bouton unique dans l'en-tête de la fiche, quelle que soit la section : étape 1 le bloc à coller (la balise, ou le `<form>` du formulaire ouvert), étape 2 ce qui est arrivé depuis                                                                                      |
| **Onglet d'un projet** | les sites reliés, même `SiteView`                                                                                                                                                                                                                                          |

Les décisions d'écran qui méritent d'être connues :

- **L'écart est la moitié de l'information.** « 1 240 vues » ne dit pas s'il
  faut regarder de plus près ; « 1 240 vues, +18 % » le dit. La période de
  comparaison est de même longueur et immédiatement antérieure : comparer à
  « le mois dernier » calendaire ferait varier le diviseur avec le nombre de
  jours.
- **Un site sans aucune mesure ne montre pas cinq zéros**, il montre son écran
  d'installation.
- **L'heure de la carte d'activité est celle du visiteur**, reconstituée depuis
  le décalage qu'il a déclaré (`tz_offset`). En heure serveur, une audience
  répartie sur trois fuseaux se moyenne en un aplat qui ne dit rien.
- **Tout ce qu'un écran montre se lit sur les faits, jamais sur un cache.** La
  seule exception est la silhouette de sept jours du sommaire, qui sort de
  l'agrégat journalier ; ses deux derniers jours, les seuls que le ménage
  horaire recalcule, sont repris sur les événements bruts.
- **Le rebond a des pages de transit.** Une application qui ouvre toujours un
  écran de chargement puis une connexion avant sa première vraie page aurait un
  rebond nul ou absurde. Le site déclare ces chemins (onglet Fréquentation,
  `AUDIENCE_MAX_TRANSIT_PATHS` au plus) et le rebond ne les compte pas : une
  visite qui n'a vu que ceux-là, ou une seule autre page, est un rebond. Le
  calcul se fait à la lecture, sur les faits, donc changer la liste vaut pour
  tout l'historique. La liste vit dans le contenu chiffré du site : ce sont des
  noms de pages.
- **Un classement n'est jamais la liste exhaustive.** Huit lignes d'emblée
  (`AUDIENCE_BREAKDOWN_DEFAULT`), « Tout afficher » va jusqu'au plafond de
  cinquante (`AUDIENCE_BREAKDOWN_MAX`), et une liste au plafond le dit. Chaque
  ligne porte au survol ce que ses deux nombres comptent.
- **La limite de l'offre se dit en permanence** (`QuotaNotice`, à partir de
  80 % du mois), pas seulement une fois atteinte : sans cela on passe sans
  transition de « tout va bien » à « plus rien n'est mesuré », et un site qui a
  cessé de compter ressemble à un site que plus personne ne visite.

Les graphes sont du **SVG écrit à la main**, `viewBox` fixe, sans
`ResizeObserver`, le patron d'`UptimeChart`. Aucune dépendance de graphes.

---

## 4. Le direct

**Deux régimes, et c'est la distinction qui compte.**

- Les mutations d'un humain (déclarer un site, le régler, renouveler sa clé, le
  supprimer) gardent `mutates` : instantanées, sous le plancher du hub.
- Le **flux d'ingestion** est coalescé à **une diffusion par minute et par
  espace** (`BROADCAST_FLOOR_MS`), dans `AudienceIngest`, par
  `deps.live.changed`. Diffuser par événement ferait re-solliciter l'écran de
  tous les membres à chaque visite.

Cette coalescence vit dans le module, jamais dans le hub : `TOPIC_FLOOR_MS`
(200 ms, `src/live/hub.ts`) doit rester strictement sous l'anti-rebond client
(`REMOTE_DEBOUNCE_MS`, 250 ms), sinon on ouvre une fenêtre d'écritures jamais
vues ([Docs/LIVE.md](../../Docs/LIVE.md)). Les deux valeurs n'ont rien à voir :
l'une est un invariant du moteur, l'autre un choix de produit.

Le hub ne fait rien quand la salle est vide : personne ne regarde, rien ne
part.

**Le sujet `audience` invalide les cinq clés d'un coup** : `count`, `list`,
`detail`, `stats`, `forms`. Ce battement doit rafraîchir _tout_ ce qui montre
de l'audience au même instant (tuile d'accueil, liste, fiche ouverte, onglet
d'un projet), sinon deux écrans de la même donnée divergeraient à la même
seconde chez la même personne. `audience.stats` reste distincte de
`audience.detail` : un réglage humain n'a aucune raison de faire relire six
requêtes d'agrégat.

Quand la limite mensuelle de l'offre vient d'être atteinte, l'ingestion prévient
l'espace à la vidange qui suit le premier refus, hors du plancher : après, et
non pendant, parce que les dernières vues acceptées ne sont en base qu'à ce
moment-là.

---

## 5. Les entonnoirs

### Le découpage

Le site suivi émet des **signaux nommés** : une page vue, un
`deveye.event('devis-etape-2')`. L'entonnoir, lui, se compose **dans DevEye**, à
partir de ce qui a déjà été observé. Trois conséquences :

- mesurer un autre parcours ne demande **aucun redéploiement** du site suivi ;
- un entonnoir supprimé ne perd **aucune mesure** : il n'a jamais rien collecté,
  il relit. Le recréer à l'identique rend exactement les mêmes chiffres ;
- un entonnoir peut être défini **avant** que le site n'émette le signal : la
  marche compte alors zéro, ce qui est la vérité et non une erreur.

Un site porte au plus `AUDIENCE_MAX_FUNNELS` (20) entonnoirs de
`AUDIENCE_FUNNEL_MAX_STEPS` (10) marches.

### La règle de rétention

> Une visite atteint la marche _i_ si la **première occurrence** de chacune des
> marches 1.._i_ s'est produite **dans l'ordre**.

Deux choses en découlent : un visiteur qui revient en arrière puis repart peut
ne pas être compté ; et un entonnoir dont deux marches reconnaissent la même
valeur les voit franchies ensemble. C'est le prix d'une définition déterministe
qui tient en **une** requête.

Techniquement : une sous-requête groupe par session et rend la première
occurrence de chaque marche (`t1`, `t2`…), la requête extérieure somme les
conditions cumulées (`t1 IS NOT NULL AND t2 >= t1 AND …`). Une marche dont le
libellé n'existe pas coupe la construction : elle vaut zéro, et tout ce qui la
suit aussi.

**`>=` et non `>`.** Les horodatages sont à la seconde et le script groupe ses
envois sur une demi-seconde : un même clic produit couramment une vue et un
événement dans la **même** seconde. Avec `>`, tout entonnoir dont deux marches
consécutives naissent du même geste compterait zéro conversion.

Les seules parties **interpolées** de cette requête sont un indice de colonne et
un nom de colonne d'événement, tirés d'un vocabulaire fermé et bornés par
`AUDIENCE_FUNNEL_MAX_STEPS`. Les identifiants de libellés sont liés. C'est la
discipline de `DIMENSION_SOURCE` : on ne met dans le texte de la requête que ce
que le serveur a lui-même écrit.

### Ce que l'écran désigne

La question qu'on se pose en ouvrant cette section est « où est-ce que je perds
le plus de monde » : la marche la plus coûteuse est mise en avant, et une seule
(à égalité, la première l'emporte). Les largeurs sont rapportées à la
**première** marche : un entonnoir se lit comme une part de ceux qui sont
entrés.

Le dialogue propose en **suggestions** les pages et les événements réellement
observés sur un an : le nom exact d'un signal vit dans le code du site suivi,
et le retaper de mémoire est le meilleur moyen de définir une marche qui ne
comptera jamais rien, puisque zéro est une réponse valable. La saisie libre
reste ouverte, pour préparer une mesure avant la mise en ligne.

---

## 6. Les retours

Beaucoup de petits sites n'ont besoin d'un serveur que pour une chose :
recueillir un message, un sondage, un signalement. Audience a déjà sous la
main une porte publique, une clé par site, une liste d'origines et un
chiffrement au repos : un **formulaire** est le canal nommé qui reçoit
(`contact`, `sondage-2026`), et un **retour** est un objet de champs nommés.

### Un formulaire se déclare, il ne naît pas d'une réception

La clé publique est **dans le HTML de la page** ; qui la lit pourrait sinon
faire apparaître vingt canaux aux noms de son choix, et autant de colonnes dans
le tableau. On ne prête pas son interface à un inconnu pour une commodité de
branchement.

Un formulaire déclare donc son nom et ses **questions typées** (`text`,
`email`, `number`, `boolean`, `choice`, avec `required`, et `multiple` pour un
choix). Le type n'est pas une décoration : un `<form>` HTML n'envoie que des
chaînes (`"4"`, `"on"`, et **rien du tout** pour une case décochée), et c'est
lui qui les ramène à la bonne valeur avant qu'on les range et qu'on les compte.
Il permet aussi d'**engendrer le formulaire à coller** et de montrer dans les
résultats une question déclarée que personne n'a remplie.

Deux échappatoires, toutes deux éteintes par défaut : le mode `auto` d'un
formulaire (tout est accepté, les colonnes se découvrent) et l'interrupteur
`forms_auto` d'un site (un nom inconnu crée son canal, jusqu'à
`AUDIENCE_MAX_FORMS`). `validate.ts` est pur et testé à part, comme
`answers.ts`, et il **normalise** en même temps qu'il refuse : la réception et
`indexableAnswers` voient donc la même valeur.

### Les origines disent trois choses, et le vide est le plus sévère

Vide, plus rien n'entre. `*`, tout entre. Sinon, la liste. Cette garde n'arrête
qu'un navigateur : l'en-tête `Origin` est posé par lui, et un script y met ce
qu'il veut. Elle empêche un **autre site** d'abuser de la clé depuis le
navigateur d'un visiteur, ce qui est déjà l'essentiel. Ce sont les quotas qui
bornent un envoi forgé.

**Le CORS ne protège rien ici** : un POST cross-origin en `text/plain` ou
`urlencoded` est une requête « simple » au sens CORS ; le navigateur l'envoie
toujours et empêche seulement d'en lire la réponse.

### La réception est synchrone, la mesure ne l'est pas

`accept()` range en mémoire et rend la main ; `submit()` écrit avant de
répondre. C'est la seule divergence entre les deux portes, et elle est
délibérée : une vue perdue au redémarrage n'est rien, un message que personne
ne lira l'est. `looksLikeBot` ne s'applique pas non plus : un envoi depuis un
serveur porte le user-agent qu'il veut ; le pot de miel (`_hp`), les origines
et les quotas sont les gardes. Un retour ne crée jamais de visite : il se
rattache à la session ouverte du visiteur si elle existe, sinon à rien.

### Les compteurs sont tenus à la réception, pas calculés à la lecture

Même impasse qu'au §1.3 : la charge utile est chiffrée, un `GROUP BY` dessus
est impossible par construction. La sortie est la même que pour les libellés,
poussée d'un cran :

```
ft_audience_form_labels   form_id, kind ('field' | 'value'), label_ref, content
ft_audience_answers       form_id, field_id, value_id, hits
```

Chaque couple (question, réponse) est haché à l'arrivée et incrémente un
compteur ; lire la vue Résultats ne déchiffre alors que les quelques dizaines
de libellés affichés, que le formulaire porte cent retours ou cinq cent mille.
Le prix est celui de tout agrégat pré-calculé : **le regroupement est figé à la
réception**, et renommer une question ne recompte pas le passé.

Deux bornes évitent qu'un champ de texte libre ne fasse une ligne de dimension
par visiteur : au-delà de 60 caractères (`AUDIENCE_ANSWER_VALUE_MAX_LENGTH`), ou
au-delà de 50 valeurs distinctes pour la même question
(`AUDIENCE_ANSWER_VALUES_MAX`), la réponse tombe dans le **seau**
`value_id = 0`, qui ne garde qu'un nombre. L'écran l'annonce (« N réponses en
texte libre »).

La suppression d'un retour rejoue les mêmes règles sur sa charge utile
déchiffrée pour décrémenter exactement ce qu'il avait compté. D'où
`answers.ts`, qui porte les règles pures **et** l'écriture qui les applique
(`countAnswers`) : la réception et la suppression passent par la même fonction.
Vider ou supprimer un formulaire efface les compteurs en bloc.

### Aucune rétention sur les retours, mais des quotas

`retention_days` purge les événements bruts. Il ne touche pas aux retours : un
événement de mesure est jetable, un message est du contenu que l'utilisateur a
demandé à collecter, et l'effacer en silence au bout de N jours serait une
perte de données.

Un formulaire plein (`AUDIENCE_FORM_SUBMISSIONS_MAX`, 50 000) se ferme
(`closed_reason = 'full'`) plutôt que d'écraser le plus ancien. Ce plafond ne
peut pas être la seule borne : à lui seul, le brûler condamne le formulaire
jusqu'à ce qu'on le vide à la main. Trois quotas en fenêtre glissante d'une
heure s'y ajoutent, réglables par site (onglet Retours), sur le motif du
plafond horaire des signalements du socle (un `COUNT(*)` servi par un index
composite, sans table de compteurs ni fenêtre à purger) :

- **par adresse et par formulaire** (`submission_ip_quota`, défaut 5/h) :
  l'envoi est ignoré, rien ne se ferme. C'est une provenance qui insiste ;
- **par adresse et par site** (`submission_ban_quota`, défaut 60/h, tous
  formulaires confondus) : la provenance est **écartée pour 24 h**
  (`ft_audience_bans`), et tout le reste du trafic continue. Le seuil est celui
  du site et non d'un formulaire, sans quoi répartir une rafale sur vingt
  canaux la diviserait par vingt ;
- **par formulaire, toutes adresses** (`form_hourly_quota`, défaut 200/h) : un
  simple **signalement** dans le journal. Rien n'est refusé, rien n'est fermé.

On sanctionne la provenance, jamais le canal : fermer le formulaire ferait
payer au site ce qu'un tiers lui fait, et la clé publique est dans sa page. Le
prix : un flot **distribué** (mille adresses, dix envois chacune) passe sous un
seuil qui ne vise qu'une provenance ; restent le plafond de stockage et le
signalement.

L'adresse n'est jamais conservée : `ip_ref` est le même condensé salé au jour
que `visitor_ref`, sans le user-agent.

La mesure a son équivalent (`event_ip_quota`, défaut 20 000 par heure sur un
site neuf, 0 = aucune limite), mais **en mémoire** : son chemin ne fait aucune
requête, et lui en donner une par visite défairait ce qui le fait tenir. Il est
donc approximatif et remis à zéro au redémarrage. Il compte **par événement et
non par requête** : compté par requête, un plafond de 100 en laisserait passer
2 000, un lot pouvant porter vingt événements (`AUDIENCE_BATCH_MAX`). Son cache
s'évince par âge, jamais en bloc : qui dispose d'un `/64` fabrique cinquante
mille clés en quelques secondes, et un `clear()` global remettrait à zéro les
compteurs de tout le monde, en boucle.

### La limite de l'offre, exacte sans requête par vue

Le quota `events` borne les vues et événements du **mois** (UTC), contre l'offre
du propriétaire de l'espace. Trois choses le rendent exact sans coûter une
requête par vue :

- le compte est tenu dans `ft_audience_usage (workspace_id, month, events)`, que
  la vidange de la file incrémente : une écriture par espace et par seconde au
  pire, jamais une par vue. Il **pend à l'espace et non aux sites**, sans quoi
  supprimer son site puis le recréer remettrait le mois à zéro. Il se lit une
  fois par minute et par espace (`PLAN_QUOTA_TTL_MS`) ;
- entre deux lectures, l'ingestion **compte elle-même** ce qu'elle accepte,
  événement par événement, pour qu'un lot n'enjambe pas la limite ;
- une seule relecture tourne à la fois par espace, et l'ancien compte sert en
  attendant : quand il expire, mille vues simultanées ne lancent pas mille
  requêtes.

`audience.list` rend ce même compte (`eventsQuota`), lu en base et jamais dans
la mémoire de l'ingestion. L'écran en tire l'état « limite atteinte », sur la
liste comme sur la fiche, et un bandeau vers les offres. Les retours des
formulaires ne passent pas par ce quota.

### Les deux portes d'envoi, et la redirection

`POST /api/t/s` accepte deux formes de corps : le JSON de `deveye.submit` (ou
d'un `curl`, ou d'un serveur), et l'`application/x-www-form-urlencoded` d'un
`<form method="post">` sans une ligne de JavaScript, reconnu à son champ
`_key` (les champs réservés `_key`, `_form`, `_next`, `_hp`, `_path` portent
un tiret bas pour ne jamais heurter une question). La seconde existe parce que
le cas visé est un site vraiment statique. Elle demande un analyseur de corps
de plus dans `src/app.ts` **et** `src/publicApp.ts`, un module ne pouvant pas
en enregistrer.

La règle du `204` du §2.4 tient, à deux exceptions près, et les deux sont des
choses que le site doit savoir :

- un **corps mal formé, ou qui ne colle pas aux questions déclarées**, rend
  `400` en nommant le champ fautif (en JSON, ou en page HTML pour un
  `<form>`). Ce n'est pas un renseignement sur les clés qui existent, c'est une
  propriété de la requête envoyée, et le seul aveu qu'elle contient (« cette
  clé existe ») porte sur une clé publique, dans la page. Sans lui, un site qui
  vient de renommer un champ n'aurait aucun moyen de s'en apercevoir ;
- une **panne d'écriture** rend `503`. Répondre « reçu » quand l'écriture a
  échoué ferait annoncer au visiteur un message perdu.

Tout le reste (clé inconnue, origine refusée, formulaire fermé ou plein,
provenance écartée, pot de miel rempli) rend le même succès.

`_next` est confronté à l'en-tête `Origin` de l'envoi, **et à rien d'autre** :
on ne redirige que vers le site d'où l'on vient, par un `303`. S'appuyer sur
les origines autorisées du site ferait de cette route un redirecteur ouvert
pour un site réglé sur `*`, et distinguerait les refus. Sans `Origin` (un
`curl`, un appel serveur) ni `_next`, une page de remerciement nue, sans
marque : c'est le visiteur d'un autre site qui la voit.

---

## 7. Le suivi d'usage de DevEye lui-même

Le module offre `AUDIENCE_SELF_PROVIDER` (`self.ts`) : déclarer un site,
déclarer un formulaire strict, retrouver un site par sa clé, et déposer des
mesures **sans passer par la route publique** (`trusted: true`, l'`Origin` ne
se contrôle pas quand c'est le serveur qui dépose). C'est ce que le suivi
d'usage de l'app consomme pour mesurer ses propres pages et celles de ses
pages publiques ([Docs/DEBUG.md](../../Docs/DEBUG.md)). Ces sites sont
anonymes, et celui que le serveur alimente n'a pas de plafond par adresse :
tous ses membres derrière un même réseau ne sont qu'une adresse.

---

## 8. Carte du code

Tout ce qui est propre à la feature vit dans le module
`DevEye/features/audience/` ; l'app ne garde que ce qui appartient à Projets
(la liaison) et l'infrastructure des routes publiques.

### Le module : `DevEye/features/audience/`

```
package.json, deveye-feature.json    deveye-feature-audience ; allowlist des 7 tables du socle
src/index.ts                         manifest + contrats (l'entrée isomorphe)
src/manifest.ts                      featureDescriptor('audience') étalé ; resources, routes.public, quotas,
                                     extraPermissions, settings.item
src/contracts/domain.ts              site, plateforme, mode visiteur, dimensions, mesures, charge d'ingestion,
                                     entonnoirs, formulaires et retours, lignes SQL, constantes
src/contracts/commands.ts            25 commandes, préfixe unique `audience.`
```

`@deveye/types` ne garde que l'**identité** (l'id dans les schémas d'espace, de
sujet live et de registre) et les **couplages déclarés** (`sdk/providers.ts`) :
`AUDIENCE_ITEMS_PROVIDER` (serveur, lu par Projets avant de relier),
`AUDIENCE_SELF_PROVIDER` (serveur, le suivi d'usage de l'app),
`AUDIENCE_CLIENT_PROVIDER` (client, composé par l'onglet d'un projet). La ligne
de liaison (`ProjectAudienceLinkRow`) vit chez Projets
(`features/projects/src/contracts/link.ts`, la table est à Projets).

### Serveur : `features/audience/src/server/`

```
index.ts        serverEntry : createRepo, features, migrationsDir, quotas (sites, events), createService
                (ingestion + providers + publicRoutes), items (homeOf, labelOf, move, copy), accountExport, e2e
repo.ts         AudienceRepo sur SdkQueryable : sites et lectures agrégées (le chemin froid), entonnoirs,
                ingestion (le chemin chaud), usage mensuel, mises à l'écart
repoForms.ts    la section « retours » du même contrat, détachée : formulaires, soumissions, compteurs
migrations/     001_forms.sql : les 4 tables ft_audience_* des retours
                002_forms_declared.sql : schéma déclaré, quotas, et « origines vides = rien »
                003_daily_events.sql : la colonne `events` de audience_daily (vues et événements nommés)
                004_usage.sql : ft_audience_usage, la consommation mensuelle par espace
                005_submission_bans.sql : ft_audience_bans, et la fin de la fermeture automatique
                006_read_indexes.sql : deux index de lecture (entonnoirs, visiteurs des 24 h)
_shared.ts      Ctx, StoredSite, nameRef, generatePublicKey, packOrigins/parseOrigins, loadSite,
                loadHomeSite, siteCipher, toSite(…, projectCount), rangeWindow, toMetrics,
                setIngest/ingestOf (le singleton), projectsProvider/projectCountsOf/projectUsageOf
crud.ts         count, list, get, siteAdd, siteUpdate, siteRotateKey, siteRemove, reorder
sites.ts        createSiteRecord : la déclaration d'un site, partagée par siteAdd et le self provider
stats.ts        overview, breakdown, activity, live, summary (les cartes du sommaire, en un aller-retour)
funnels.ts      funnelList, funnelAdd, funnelUpdate, funnelRemove
forms.ts        formList, formAdd, formUpdate, formClear, formRemove, submissionList,
                submissionRemove, results ; createFormRecord
validate.ts     un envoi confronté aux questions déclarées, et converti (pur)
answers.ts      ce qu'on compte dans un retour (pur), et countAnswers qui l'applique
handlers.ts     l'agrégat des vingt-cinq commandes
service.ts      AudienceIngest sur FeatureServiceDeps : caches, file, lot, coalescence, ménage horaire,
                sel dérivé, quotas ; submit() : la réception des retours, synchrone
routes.ts       publicRoutes sur SdkPublicApp : GET /t.js · POST /api/t/b · POST /api/t/e · POST /api/t/s
script.ts       le script servi aux pages suivies, et son ETag
self.ts         AUDIENCE_SELF_PROVIDER : le suivi d'usage de DevEye
copy.ts         audienceTree : ce dont un site est fait (colonnes scellées), la copie
move.ts         le changement d'espace d'un site (rescellement, nom unique)
accountExport.ts  l'export des données du compte, table par table
e2e.ts          le scénario de bout en bout : déclarer, recevoir une visite par la route publique, compter
normalize.ts    chemins, hôtes, référents, condensés, clés de jour et de mois (pur)
userAgent.ts    navigateur / système / appareil, détection des robots (pur)
*.test.ts       handlers, forms, service, routes, answers, validate, normalize, repo, move, accountExport
                (harnais @deveye/types/sdk/testing)
```

Le dépôt ne connaît pas Projets : le compte et la liste des projets viennent du
contrat `PROJECTS_USAGE_PROVIDER` (`projectCountsOf`, `projectUsageOf`), et
`toSite` reçoit le compte en paramètre ; sans contrat, zéro projet partout,
aucune commande ne casse. L'ingestion est un singleton du module posé par
`createService` (`setIngest`), lu par les handlers (`ingestOf()?.invalidate()`).

### Ce qui reste dans l'app : `DevEye/src/`

```
db/migrations/076_audience.sql             les 5 tables de la mesure (allowlist du module)
db/migrations/077_project_audience_links.sql  la liaison (table de Projets)
db/migrations/078_audience_funnels.sql     entonnoirs et marches
db/migrations/079_audience_visitor_mode.sql   le mode de reconnaissance du visiteur
db/migrations/133_pin_collation.sql        épingle ces tables en utf8mb4_general_ci
features/projects/src/server/repo/links.ts listSiteIds, linkSite, unlinkSite, unlinkAllSites,
                                           listSiteUsage, countSiteLinks (chez Projets)
features/projects/src/server/usageProvider.ts   l'entrée `audience` de PROJECTS_USAGE_PROVIDER
features/projects/src/server/audienceLink.ts    le pointeur d'un projet (existence par AUDIENCE_ITEMS_PROVIDER)
features/_sdk/register.ts                  modulePublicRoutes(app, listener), isModulePublicPath(url)
features/_sdk/context.ts                   ctx.origins { app, public, site } (AUDIENCE_ORIGIN || PUBLIC_ORIGIN, SITE_URL)
app.ts                                     le délégateur CORS (isModulePublicPath), modulePublicRoutes(app, 'app'),
                                           les analyseurs text/plain et x-www-form-urlencoded
publicApp.ts                               le second écouteur : mêmes analyseurs, modulePublicRoutes(app, 'public')
Utils/Env.ts                               AUDIENCE_ORIGIN, PUBLIC_LISTEN_PORT (infrastructure)
Services/debug/selfTracking/               le suivi d'usage de l'app, par AUDIENCE_SELF_PROVIDER
client/vite.config.ts                      le proxy de /t.js en développement
```

### Client : `features/audience/src/client/`

```
index.tsx           clientEntry : Widget, Full, settingsPanels (general, traffic, forms), providers
Audience.tsx        liste + fiche ; possède le niveau live `l1` (l'id du site)
api.ts              featureApi(manifest)
SiteList.tsx        les cartes + le glisser-déposer (useDragReorder du SDK)
SiteDetail.tsx      en-tête + sommaire + la section ouverte ; possède le niveau live `l2` (la section)
SiteHub.tsx         les cartes du sommaire (audience.summary)
HubTrend.tsx        la courbe des sept jours, en bas du sommaire (même commande que la section)
SectionCard.tsx     la forme commune d'une carte du sommaire
SiteView.tsx        la fréquentation ⟵ partagée avec l'onglet d'un projet
Funnels.tsx         les entonnoirs ⟵ partagés avec l'onglet d'un projet
RangeBar.tsx        les cinq fenêtres, partagées par les blocs qui mesurent
QuotaNotice.tsx     où en sont les vues du mois face à l'offre
Forms/Forms.tsx     les retours : sélecteur de formulaire, onglets Tableau / Résultats, export
Forms/SubmissionTable.tsx   le tableau (colonnes déduites, tri et recherche côté client)
Forms/SubmissionDialog.tsx  un retour brut, avec le contexte de sa visite
Forms/Results.tsx   la répartition des réponses, question par question
Forms/export.ts     le CSV des retours chargés
SiteDialog.tsx      déclarer un site (nom, description, plateforme, origines) ; création seulement
SiteGeneralPanel.tsx  onglet Général : identité, plateforme, origines, collecte, suppression
SiteTrafficPanel.tsx  onglet Fréquentation : visiteurs, pages de transit, rétention, quota d'événements
SiteFormsPanel.tsx    onglet Retours : formulaires déclarés, création à la volée, quotas
FormEditor.tsx        déclarer un formulaire et ses questions typées ; renommer, fermer, vider, supprimer
useSiteDraft.ts       le brouillon partagé des trois onglets (siteUpdate prend le site entier)
InstallDialog.tsx   contextuel (`scope`) : même forme partout (étape 1 le bloc à coller,
                    étape 2 ce qui est arrivé), contenu propre à la section, la rotation de clé
FunnelDialog.tsx    définir un parcours à partir du déjà-observé
FunnelDetailDialog.tsx
Stats/{StatBand,TrendChart,Heatmap,TopList,FunnelBar,FunnelSteps}.tsx
AudienceWidget.tsx  format.ts  usage.ts (les exemples d'appel à coller)  style.module.css
provider.tsx        AUDIENCE_CLIENT_PROVIDER : ce que l'onglet d'un projet compose
```

`features/projects/src/client/Audience/` se réduit à `Audience.tsx` (enveloppe
mince) et `LinkSiteDialog.tsx`, qui composent le contrat client du module par
`moduleClientProvider(AUDIENCE_CLIENT_PROVIDER)`. L'onglet **Audience** d'un
projet n'apparaît qu'à partir du premier site relié ; sans liaison, il repart
dans le menu « + » de la barre d'onglets (« Ajouter un site »), qui rouvre le
même `LinkSiteDialog` (voir [Projets](../projects/README.md)).

---

## 9. Configuration

Le module ne lit aucune variable d'environnement lui-même. Il dépend de celles
du socle (`src/Utils/Env.ts`, `.env.template`) :

| Variable             | Défaut        | Rôle                                                                                        |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`      | (obligatoire) | l'adresse de l'app ; celle de l'ingestion à défaut d'`AUDIENCE_ORIGIN`                      |
| `AUDIENCE_ORIGIN`    | vide          | l'adresse par laquelle les pages suivies atteignent l'ingestion (`ctx.origins.public`)      |
| `PUBLIC_LISTEN_PORT` | vide          | le second écouteur, réservé aux routes publiques des modules ; vide, tout reste sur un port |
| `TRUST_PROXY`        | `1`           | combien de proxys précèdent le serveur : le plafond par IP en dépend, sur les deux ports    |
| `RATE_LIMIT_MAX`     | `200`         | le plafond global du serveur, par minute et par IP ; les routes d'ingestion ont le leur     |

Les défauts d'un site (rétention 90 jours entre 7 et 730, quotas des retours
5/60/200 par heure, 20 000 événements par adresse et par heure) sont des
constantes de `src/contracts/domain.ts`, réglables site par site.

---

## 10. Les quotas de l'offre

Le manifest déclare deux clés (`quotas`), que le module de facturation des
comptes borne par offre (`DevEye-Billing/src/server/plans.ts`) :

| Clé               | Ce qu'elle compte           | Gratuite | Pro     |
| ----------------- | --------------------------- | -------- | ------- |
| `audience.sites`  | sites suivis (stock)        | 1        | 5       |
| `audience.events` | vues et événements par mois | 10 000   | 100 000 |

Au-delà du stock, les sites les plus récents sont **mis en pause** par l'hôte
(`PlanPausedBadge` sur la carte, l'ingestion n'accepte plus rien pour eux) sans
que `active`, le choix de l'utilisateur, ne bouge. Au-delà du flux mensuel,
l'ingestion suspend la mesure jusqu'au mois suivant et les écrans le disent
(§6). Une installation sans module de facturation n'a aucune limite.

---

## 11. Notifications

Audience ne notifie pas (`notifies: false` dans le registre) : ni une visite,
ni l'arrivée d'un retour. L'arrivée d'un retour se voit dans la carte Retours
du sommaire et dans la section Retours, rafraîchies par le battement du
direct.

---

## 12. Pièges, et pourquoi ils existent

### Deux tuiles voisines ne peuvent pas porter le même pictogramme

L'icône est `eye-open` : l'œil dit « des vues », là où la courbe d'activité
d'Appareils dit « une machine qui tourne ». Sur la grille d'accueil, deux
tuiles côte à côte au même pictogramme seraient indiscernables.

### Le filet de démarrage ne voit aucune commande de ce module

`MUTATION_VERB` (`src/features/_topics.ts`) cherche un verbe **juste après le
point**. Les commandes d'ici sont en camelCase sous un préfixe unique
(`audience.siteAdd`) : il n'en verra aucune, exactement comme pour git, les
bases et les projets. → **Relire `mutates` à la main.** En revanche, un préfixe
absent de `COMMAND_PREFIX_TOPIC` fait échouer le démarrage : c'est un contrat,
pas une heuristique.

### Toute mutation d'un site doit invalider le cache de l'ingestion

`ingestOf()?.invalidate()`. Sans lui, un site qu'on vient d'éteindre continue
d'accepter des mesures pendant toute la vie du processus, et une clé qu'on
vient de renouveler laisse l'ancienne entrer, c'est-à-dire que la rotation ne
sert à rien, précisément dans le cas où on la demande. La panne est
silencieuse : elle se découvre en relisant des chiffres qu'on croyait arrêtés.

`audience.reorder` est la seule écriture qui **n'invalide pas**, et c'est
juste : l'ordre d'affichage n'entre dans aucune décision de l'ingestion. Les
mutations d'un formulaire invalident aussi (le cache des formulaires est vidé
avec celui des sites).

### Le ménage des libellés est le seul coût non borné

La forme naturelle, `NOT EXISTS (… WHERE e.path_id = l.id OR …)`, est un
piège : la sous-requête est **corrélée**, donc rejouée pour chaque libellé, sur
des colonnes qu'aucun index ne couvre. Un site à trois cents libellés y
parcourrait trois cents fois sa table de faits, toutes les heures.

La forme ensembliste (`NOT IN`, bornée par `site_id`) est matérialisée une
fois, et `idx_audience_events_window` porte `path_id` **et** `name_id`
justement pour la servir entièrement depuis l'index.

`IS NOT NULL` dans chaque sous-requête n'est pas décoratif : `NOT IN` face à un
seul NULL ne rend **jamais** vrai, et le ménage ne supprimerait alors rien, en
silence et pour toujours.

Ce ménage n'est pas cosmétique : un site qui appelle `identify()` accumule un
libellé par utilisateur, qui survivrait à l'expiration de toutes ses sessions.

### La colonne qui n'a pas de `workspace_id`

`audience_labels` pend à son site, qui seul porte l'espace : pas de colonne
dupliquée sur une table qui grandit vite, une colonne dupliquée étant un second
endroit où la vérité peut diverger. Ce qui rattache un libellé à son espace se
retrouve par jointure sur `audience_sites`.

### La requête est retirée des chemins

`/produits?utm_source=x` compte comme `/produits`. Les garder ferait de chaque
paramètre une ligne de plus dans le classement. Ce qu'on perd, la provenance,
est déjà porté par le référent, à sa place.

### L'ordre des tests de user-agent **est** le sujet

Presque tous mentent par héritage : Edge contient « Chrome », Chrome contient
« Safari », tout Android est un Linux et le dit. On va donc du plus spécifique
au plus général, et changer cet ordre casse la détection sans casser un seul
test de type.

### Le ménage horaire refait hier et aujourd'hui

L'agrégat journalier est recalculé pour les deux derniers jours à chaque
passe : aujourd'hui bouge encore, et rien ne garantit qu'une instance tournait
à minuit, alors qu'un jour manquant est un trou définitif dès que les
événements bruts ont expiré. La rétention minimale de sept jours garantit que
ces deux jours sont toujours entiers sur le brut.

---

## 13. Limites

- **Pas de propriétés sur un événement.** La variante doit entrer dans le nom
  (`tarif-choisi-studio` plutôt que `tarif-choisi` + `{plan}`).
- **Pas de temps de conversion** : on sait combien passent une marche, pas
  combien de temps ils mettent.
- **Pas de pays** : il faudrait embarquer une base GeoIP et la tenir à jour.
  Les fuseaux répondent à la même question à moindres frais.
- **Aucune notification à l'arrivée d'un retour** (§11).
- **Le tri et la recherche du tableau portent sur les lignes chargées**, jamais
  sur tout le formulaire : la charge utile est chiffrée, la base n'a rien à
  quoi appliquer un `ORDER BY` ni un `LIKE`. L'écran le dit sous le tableau.
- **Pas de package npm ni de module React Native** : la balise couvre les pages
  web et les projets React ; le contrat d'ingestion est neutre (§2.8).
- **Pas de visiteurs revenus en mode anonyme** : conséquence directe du sel
  tournant (§1.5) ; le mode persistant les compte, au prix d'un consentement.
- **Perte d'une seconde d'événements** sur un arrêt brutal (§2.5).
- **La cardinalité des libellés n'est bornée qu'indirectement.** Qui connaît la
  clé d'un site et se trouve sur une origine autorisée peut envoyer des chemins
  tirés au sort et faire grossir `audience_labels`. Le plafond par adresse, le
  plafond de débit et la liste d'origines le bornent ; le ménage horaire rend
  la place, mais seulement une fois les faits expirés. Il n'y a pas de plafond
  de libellés par site.
- **Les compteurs des retours ne se recalculent pas.** La charge utile est
  chiffrée, donc rien ne relit le passé pour les rétablir : les deux voies qui
  les écrivent passent par `countAnswers`, mais aucune transaction ne les lie à
  l'écriture du retour lui-même, le SDK n'exposant pas de transaction.
- **La coquille de réglages ne garde pas d'un départ.** Les trois panneaux
  signalent un brouillon non enregistré, mais rien ne retient la fermeture :
  cela relève de la coquille, pour toutes les features à la fois.
- **La migration `002` n'est pas idempotente sur sa dernière instruction**
  (`UPDATE origins = '*'` sur les sites sans origine) : un échec plus loin dans
  le fichier la rejouerait et rouvrirait des sites délibérément fermés. Une
  migration jouée ne se modifie plus.
- **Le direct reste local au processus** : deux instances derrière un proxy
  font des salles silencieusement séparées.

---

## 14. Tests

```bash
cd DevEye
npm run test:features
```

Les tests du module tournent hors serveur (harnais `@deveye/types/sdk/testing`,
dépôts en mémoire, aucune base ni réseau). Ce qu'ils ne couvrent pas se vérifie
sur un serveur monté : le montage réel des routes par l'hôte (helmet compris :
CORP `same-origin` préservé ailleurs), les analyseurs `text/plain`,
`application/json` et `application/x-www-form-urlencoded`, le plafond de
débit appliqué par Fastify, le délégateur CORS, et la redirection `303` telle
que le navigateur la suit après un `<form>`. Le scénario `e2e.ts` (page Tests
et débogage, [Docs/DEBUG.md](../../Docs/DEBUG.md)) couvre le chemin de bout
en bout sur l'instance qui le lance.
