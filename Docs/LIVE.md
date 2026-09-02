# La présence en direct dans DevEye

> Écrit le 6 août 2026, à la fin du chantier qui l'a introduite ; relu et mis à
> jour le 21 août 2026. Compagnon de `WORKSPACES.md` : celui-ci dit qui a le
> droit de voir quoi, celui-là dit qui est là, où, et ce qui vient de changer.
> Il dit **pourquoi** ; le code dit comment.

---

## 1. Ce que c'est

Trois choses, un seul index — parce qu'elles répondent toutes à « qui est dans
quelle salle ? » :

1. **Le roster** — qui est dans l'espace, et à quel endroit exactement.
2. **Les curseurs** — entre pairs situés au même endroit, à la Figma.
3. **Les changements** — « quelque chose a bougé, re-sollicitez ».

Vocabulaire : **`live`** dans le code, « **Présence** » dans l'interface. Le mot
`presence` était déjà pris par la présence des _agents_ (`src/agent/presence.ts`,
`DEVICE_PRESENCE_EVENT`) ; le mot « présence » côté interface, lui, était libre.

> **Le transport n'était pas le sujet.** Toutes les commandes (394 au 21 août 2026) passaient déjà par `/ws` avant ce chantier. Ce qui manquait, c'était un
> registre des connexions vivantes, une notion de _lieu_, et une invalidation
> poussée par le serveur.

---

## 2. Le cœur : le chemin de localisation

Un utilisateur est un **chemin de segments**, chacun `kind:value` :

```
[]                                l'accueil
['view:mail']                     la feature Mail
['view:mail','l1:12']             la Boîte1
['view:mail','l1:12','l2:34']     le dossier INBOX
['view:mail','l1:12','l2:34','l3:56']  le message 56, ouvert
```

Trois règles, et elles suffisent à tout :

| Mon chemin vs celui du pair       | Ce que je vois                              |
| --------------------------------- | ------------------------------------------- |
| **identiques**                    | son curseur, pseudo au-dessus, à sa couleur |
| divergents à partir du niveau _k_ | le segment `pair[k]` est **entouré**        |
| il est en amont de moi            | rien : il est derrière moi                  |

Descendre l'arbre fait donc glisser le surlignage d'un cran à chaque niveau,
jusqu'à ce que les chemins coïncident et que les curseurs prennent le relais.
Aucun cas particulier nulle part.

> La règle vit dans `client/src/live/paths.ts`, isolée du rendu : chacun de ses
> cas a une conséquence à l'écran, elle mérite d'être lisible et vérifiable seule.
>
> Sa première version exigeait que le chemin du pair **commence** par le mien.
> C'était trop étroit : ouvrir une boîte mail sélectionne d'office la boîte de
> réception, donc on est toujours déjà _dans_ un dossier — jamais au niveau
> au-dessus, seule position où cette version pouvait s'appliquer. Aucun dossier ne
> se surlignait donc jamais. Même piège pour Monitoring, qui sélectionne d'office
> le premier appareil. Le niveau de divergence, lui, couvre aussi les nœuds
> **frères**, qui sont le cas courant.

**La valeur d'un segment peut contenir des deux-points** (`view:device:<uuid>`) :
on découpe au **premier**, jamais avec un `split` complet.

### Ce qu'une feature a à faire

Deux appels, et elle n'a jamais à connaître l'arbre :

```tsx
// déclarer où je suis — et recevoir où une téléportation veut m'emmener
const target = useLiveSegment('l1', selectedId ? String(selectedId) : null);

// entourer un nœud de la couleur de qui s'y trouve
<div className={styles.card} {...useLiveOutline('l1', String(service.id))}>

// dans une liste, un hook par ligne est impossible : forme « consultation »
const outlineOf = useLiveOutlines('l2');
{folders.map((f) => <button {...outlineOf(String(f.id))} />)}
```

Les tuiles de l'accueil n'ont **rien** à écrire : `Widget.tsx` porte
`useLiveOutline('view', widgetId)`, et le `widgetId` _est_ le segment de vue.

**Un seul déclarant par niveau.** `useLiveSegment` écrit dans une map indexée par
`kind` : deux composants sur le même niveau s'écraseraient, et celui qui se
démonte effacerait ce que l'autre vient de poser. Le déclarant est donc toujours
celui qui détient la sélection — c'est pourquoi CloudSync fait remonter
l'ouverture d'un dialogue depuis ses cartes. `useLiveOutlines` n'écrit rien et se
consulte autant qu'on veut.

### Les niveaux sont positionnels

`LIVE_SEGMENT_ORDER` dans `client/src/stores/live.ts` : `view`, `l1`, `l2`, `l3`, `l4`.
Positionnels et non sémantiques, et c'est ce qui permet à n'importe quelle feature
d'entrer dans le moteur sans rien ajouter là : `l1` est « la chose sélectionnée
dans cette feature », boîte mail, service surveillé, ville, appareil, note ou
partage. Des noms sémantiques auraient obligé à étendre la liste par feature, et
surtout à décider où insérer `service` par rapport à `folder` — une question sans
réponse.

Aucun risque de confusion entre features : les niveaux ne sont comparés qu'après
un préfixe commun, lequel commence toujours par `view:<feature>`.

L'ordre est déclaré plutôt que déduit du montage : les effets React se
déclenchent de la feuille vers la racine, et s'y fier donnerait des chemins à
l'envers.

### Où chaque feature en est

| Feature                            | Niveaux                                               | Valeur `l1`     |
| ---------------------------------- | ----------------------------------------------------- | --------------- |
| Mail                               | boîte, `l2` dossier, `l3` message ouvert              | l'id            |
| Projets                            | projet, `l2` onglet, `l3` carte, `l4` onglet de carte | l'id            |
| Uptime                             | le service ouvert                                     | l'id            |
| Git                                | le dépôt ouvert                                       | l'id            |
| Déploiement                        | la cible ouverte                                      | l'id            |
| Bases de données                   | la base ouverte                                       | l'id            |
| Audience                           | le site ouvert                                        | l'id            |
| Sauvegardes                        | le travail ouvert                                     | l'id            |
| Monitoring / Sentinelle            | l'appareil sélectionné                                | l'uuid          |
| Météo                              | la ville consultée                                    | l'id            |
| Notes / Coffre / CloudSync         | la note, l'entrée, le partage ouvert                  | l'id            |
| Finance                            | l'onglet actif                                        | son nom         |
| Appareils, Journaux, Utilisateurs… | aucun                                                 | (la vue suffit) |

La valeur `l1` d'un élément est son identifiant nu, partout : le préfixe
`view:<feature>` du chemin dit déjà de quelle sorte d'élément il s'agit. Six
features ont longtemps eu chacune leur préfixe (`repo:12`, `db:12`, `target:`,
`site:`, `job:`, `project:`), ce qui obligeait une table centrale
(`ITEM_SEGMENT` dans `goToHome.ts`) puis un `itemSegment` au manifest des
modules à connaître le format de chacune pour téléporter vers la fiche d'un
élément projeté (voir `SETTINGS.md`). Le 27 août 2026, toutes sont passées à
l'id nu, et `goToHome.ts` écrit `l1:<id>` lui-même.

**Descendre d'un cran coûte un consommateur.** Mail s'arrêtait au dossier, si
bien que deux lecteurs de deux messages différents avaient le même chemin et
échangeaient leurs curseurs par-dessus des popups qui ne montraient pas la même
chose. Le message ouvert est donc un `l3`. Mais un niveau que personne n'entoure
rend le pair invisible, puisque son segment divergent ne désigne plus rien à
l'écran : la liste des messages consulte `useLiveOutlines('l3')`, comme
l'arborescence le fait pour `l2`. Ajouter un niveau sans son halo est une perte
nette.

Et un niveau qui en attend un autre s'applique **par l'effet**, jamais par
`useLiveItemTarget` : celui-ci consomme sa cible dès que `ready` passe à vrai,
donc une seule fois. Ouvrir le message avant que son dossier ne soit posé le
ferait refermer par l'effet de changement de dossier, et la cible perdue ne
reviendrait pas. Mail attend donc l'extinction de la cible `l2`, puis rejoue la
sienne à chaque rendu, comme le dossier attend son arborescence. Il ouvre par
identifiant et non par la ligne de la liste : celle-ci peut être sur une page
qu'on n'a pas déroulée.

---

## 3. Sécurité — ce que le moteur ne dit pas

L'appartenance reste la frontière, et la présence ne la contourne pas.

- **L'entrée en salle est gratuite et sûre.** `live.here` est une commande
  normale : l'enveloppe est résolue par `access.forWorkspace()`, donc
  l'appartenance est déjà vérifiée quand le handler s'exécute.
- **Les chemins sont tronqués par destinataire.** Sans `read` sur la feature de
  la racine, le pair apparaît « ailleurs » (`path: []`). Seule la racine est
  examinée : un segment plus profond appartient par construction à la même
  feature.
- **Les vues de compte et d'administration sont privées pour tout le monde.**
  Profil, Sécurité, Journaux, Utilisateurs, Gestion de l'espace → `livePathGate`
  rend `'private'`. Attention : `featureBehind` côté client rend `null` pour
  elles parce qu'elles ont leurs propres gardes ; ici `null` voudrait dire
  « visible par tous ». D'où un troisième cas, plutôt qu'une réutilisation.
- **La voie rapide des curseurs ignore l'espace de l'enveloppe.** Il est contrôlé
  par le client et n'est validé que dans `access.forWorkspace()`, que cette voie
  court-circuite. Seul `conn.workspaceId`, posé par un `live.here` passé par le
  dispatcheur, fait foi — et la trame ne porte que des coordonnées.
- **Les droits viennent d'un instantané estampillé**, déposé par le dispatcheur à
  chaque commande. Ils ne sont jamais ré-résolus au moment de diffuser :
  `forWorkspace()` rend une promesse qui peut rejeter, et un rejet dans un
  minuteur est un rejet non traité. Époque périmée = **aucun droit**.
- **L'expulsion est explicite.** `invalidateAccess()` n'incrémente qu'un compteur
  relu par la _commande suivante_ ; une socket assise dans une salle n'en émet pas
  forcément. D'où `evict` / `evictRoom` / `evictEverywhere` posés à côté de chaque
  `invalidateAccess()` qui **retire** un accès, et `resync` pour un rôle
  simplement rétréci — `share.grantSet` compris, qui l'avait oublié : sans lui,
  l'époque périmée faisait tomber la trame « les appareils ont changé » pour
  TOUT le monde, et une permission réglée n'avait l'air de prendre qu'au
  rechargement. `userChanged`, lui, vise un compte **hors de sa salle** :
  gagner ou perdre un espace se décide depuis cet espace pendant que
  l'intéressé est assis ailleurs, et sans cette voie sa liste d'espaces
  resterait figée jusqu'au rechargement.

---

## 4. Le rafraîchissement en direct

Une commande qui écrit le déclare, à côté de son `access` :

```ts
defineFeature({ ...uptimeAdd, mutates: true, handler: … })
```

219 commandes sur 394 (au 21 août 2026). Le sujet est déduit du préfixe **via une table explicite**
(`src/features/_topics.ts`), jamais du préfixe brut : `agent.*` et `devices.*`
désignent tous deux les appareils, et six préfixes ne correspondent à aucune feature d'espace. Un préfixe absent de
la table **fait échouer le démarrage**.

`mutates: true` bat le sujet de la feature ; une **liste** nomme les sujets à
battre à la place : le sien, un sujet secondaire déclaré par le manifest du
module (`topics`), ou celui d'une autre feature dont les écrans reflètent la
donnée (`projects.repoLink` bat `['projects', 'git']` : la fiche d'un dépôt
montre les projets qui l'utilisent). Le boot refuse un sujet inconnu
(`buildTopicIndex`, qui lit les manifests installés par `moduleTopics()`). Un
service de fond dispose du même choix : `deps.live.changed(workspaceId,
topics?)`.

### Les sujets secondaires d'un module

Un module vaut un sujet, qui est son id. Il peut en déclarer d'autres
(`manifest.topics`, chacun avec les clés de ressources qu'il ravive) : c'est ce
que fait Projets pour `projectsChat`, le fil de discussion d'une carte changeant
à une tout autre cadence que le tableau qui le porte. Longtemps un sujet natif
inscrit en dur dans `@deveye/types` (`nativeLiveTopicSchema`, `TOPIC_FEATURE`),
il est depuis le rapatriement de Projets le premier sujet secondaire de module :
le droit d'accès est celui de la feature qui le déclare, et l'app ne le connaît
que par le manifest (voir [Projets](../features/projects/README.md) §3).

### Le filet, et pourquoi il est porteur

Un contrôle au démarrage liste les commandes au nom mutant qui ne déclarent pas
`mutates`, avec une liste d'exceptions (`NON_MUTATING`) tenue **à zéro
avertissement**. C'est un avertissement, pas une erreur — mais comme les sondages
périodiques ont disparu, c'est désormais le **seul** garde-fou contre une donnée
qui reste figée. À lire à chaque ajout de commande.

### Les tâches de fond

Elles écrivent sans commande, donc sans socket : elles appellent
`liveHub.changed()` directement.

- le service de fond d'Uptime (`features/uptime/src/server/service.ts`, par
  `deps.live.changed`) : **uniquement sur une transition d'état**. La boucle tourne
  toutes les dix secondes sur tous les services ; diffuser sans condition ferait
  re-solliciter le serveur en permanence par tous les clients.
- la relève de fond de Mail (`features/mail/src/server/service.ts`, par
  `deps.live.changed`) : après une relève qui a fait bouger quelque chose, et
  quand l'état d'une boîte change (panne, retour au vert), jamais à l'horloge.
- `agent/ws.ts` — un agent qui arrive ou part change la liste d'appareils.
- `agent/routes.ts` : l'enrôlement (`POST /api/agent/enroll`) passe par HTTP,
  pas par une commande WS : sans ce signal, rien n'en avertirait personne.
  L'émission des codes de liaison, elle, est une commande du module Appareils
  (`devices.linkCode*`, `mutates: true`) depuis son rapatriement.
- et tout service arrivé depuis suit la même règle — sauvegardes, Sentinelle,
  ingestion d'audience (`features/audience/src/server/service.ts`, coalescée
  à une fois par minute et par espace), relevés de bases : qui écrit sans
  commande appelle `liveHub.changed()` lui-même (`deps.live.changed` pour un
  module).

### Les sondages supprimés

`devices` (6 s), `uptime.count` (30 s), `uptime.list`, `mail.accountList`
(20 s), les codes d'appairage (4 s). `deviceUsage` (10 s) est passé à
l'abonnement métriques déjà existant — son commentaire disait que deux
consommateurs se désabonneraient l'un l'autre, ce que `stores/metricsSubscription`
avait justement résolu depuis.

**Trois minuteurs restent, et ce n'est pas un oubli** : la météo (10 min, source
externe), le statut serveur (REST, démarrage), la fin d'OAuth mail (externe). Plus
un quatrième, différent par nature : la **barre de progression** d'une synchro
mail en cours (1,5 s) lit un compteur qui ne vit qu'en mémoire du serveur le temps
de la synchro, et s'arrête avec elle.

### L'invariant des deux anti-rebonds

Plancher serveur **200 ms** (`src/live/hub.ts`) < anti-rebond client **250 ms**
(`stores/invalidation.ts`). Une écriture dont la trame est étouffée côté serveur
reste visible par la re-sollicitation que la trame précédente a déjà programmée.
**Inverser cet ordre ouvrirait une fenêtre d'écritures jamais vues.**

### La voie de poussée d'un module

`live.changed` dit « quelque chose a bougé » ; certains états doivent se voir
**pendant** qu'ils bougent, et une re-sollicitation de tout l'état pour montrer
une cellule dessinée est le mauvais outil. D'où `publishFeature` sur le hub,
offerte aux modules par la capacité `live.publish` (`ctx.live.publish` en
requête, `deps.live.publish` dans un service) : une trame nommée sous le
préfixe du module, aux connexions de la salle qui ont `read` sur SA feature.

Trois différences avec `changed`, et elles sont voulues :

- **Aucun plancher de débit.** Une trame porte le changement lui-même :
  l'étouffer le perdrait au lieu de le retarder. Ce qui borne la cadence est
  celle de la commande qui l'émet.
- **Aucune projection.** Le partage inter-espaces ne s'applique pas : la trame
  reste dans l'espace nommé.
- **Aucune garantie.** Une socket en retard (`BACKPRESSURE_BYTES`) la perd en
  silence, exactement comme un curseur. Un module qui s'en sert doit savoir se
  remettre d'aplomb seul, et le Jeu de la vie en est l'exemple : ses clients
  redemandent le plateau à la réouverture de la socket, au retour de l'onglet
  et toutes les 25 s.

Le premier client est le module Jeu de la vie, dont c'est toute l'architecture :
le serveur fait autorité sur l'état et sur l'instant, chaque navigateur
recalcule les générations avec le même moteur, et il ne circule que les gestes
des joueurs, estampillés du tour auquel les appliquer.

---

## 5. Les curseurs

### La surface

Jamais un nœud appartenant à une feature : `FeatureKeepAlive` déplace
physiquement le conteneur d'une feature entre le corps de la popup et un support
caché, et `WidgetPopup` recrée son élément de défilement à chaque ouverture.

La surface est **le corps de la popup**, ou **la colonne de contenu de l'accueil**
quand rien n'est ouvert. Comme les curseurs ne s'échangent qu'entre pairs au même
chemin, les deux ont forcément la même surface logique.

C'est bien la **boîte que le contenu remplit** — `content`, bornée à 1280 px et
centrée, et non `main` qui occupe toute la largeur. C'est ce qui rend le repère
proportionnel : sur un écran large, `main` déborde le contenu de plusieurs
centaines de pixels de chaque côté, et un `x` rapporté à `main` plaçait le curseur
loin de l'élément visé chez qui n'a pas la même largeur. La popup, elle, est déjà
bornée à 1240 px : son propre corps fait un repère juste.

**Ce qu'aucun repère ne peut rattraper**, et il faut le savoir : une grille qui
**se réagence** — quatre colonnes ici, trois là — place la même tuile ailleurs. La
correspondance vaut pour tout ce qui ne change que de largeur (listes, colonnes,
lignes), pas pour ce qui change de disposition.

**La surface est un repère, pas un cadre.** Rien n'écrête les coordonnées à ses
bords : le pointeur d'un pair vit aussi dans les marges de la popup et jusqu'aux
bords de l'écran, et l'y faire disparaître donnait l'impression qu'il s'évanouissait
alors qu'on était toujours sur la même page. Deux conséquences, faciles à défaire
par inadvertance :

- l'effacement est branché sur le `pointerleave` du **document**, jamais sur celui
  de la surface — c'était la vraie cause de la disparition sur les côtés ;
- seul le cadre de la fenêtre borne l'affichage, et la couche des curseurs est en
  `--z-toast` pour rester au-dessus des dialogues.

### Le piège qui a coûté le plus cher

> **La géométrie de la surface se lit au rendu, elle ne se met jamais en cache.**
>
> La version mémoïsée, rafraîchie sur `ResizeObserver`, semblait évidente. Elle
> est fausse : la popup s'ouvre par un morphe framer-motion (`layoutId`) qui anime
> un `transform`, lequel ne change pas la boîte de bordure et **ne déclenche donc
> aucun `ResizeObserver`**. La mesure prise à l'ouverture restait figée sur la
> taille de la carte d'origine (287×198 au lieu de 1222×770), tous les curseurs
> tombaient hors cadre, et rien ne s'affichait — sans la moindre erreur.
>
> Symptôme trompeur : les curseurs marchaient parfaitement sur l'accueil et
> disparaissaient dès qu'une feature était ouverte. Trouvé en pilotant deux vrais
> navigateurs et en instrumentant le calcul, pas à la lecture.

### Les unités, mixtes à dessein

`x` **relatif** (0..1) à la largeur : la popup est bornée à 1240 px, au-delà les
deux fenêtres ont la même boîte, en dessous elles divergent.
`y` en **pixels absolus du contenu** : « le pair est sur le 14ᵉ message » est le
sens qu'on veut, alors qu'une fraction de la hauteur se décalerait dès qu'une
liste est chargée plus loin d'un côté.

Hors cadre, le curseur est **masqué**, pas épinglé au bord : un curseur collé au
bord se lit comme quelqu'un qui serait là et qui n'y est pas.

### Les couper — et pourquoi c'est réciproque

Le profil porte un interrupteur « Curseurs des autres ». Il pose le drapeau de
compte `hideLiveCursors` dans `users.settings` (`user.setSetting`), donc il suit
la personne d'un navigateur à l'autre, et non la machine.

La coupure vaut **dans les deux sens** : `LiveCursors` cesse d'afficher les
curseurs des pairs, et `LiveProvider` cesse d'émettre le sien. Regarder sans être
vu n'aurait pas été un réglage défendable dans un espace partagé.

Côté mise en œuvre il n'y a presque rien à écrire, et c'est voulu : le drapeau
entre dans les dépendances de l'effet d'émission, si bien que l'activer démonte
l'exécution précédente — dont le nettoyage envoie déjà `cursor: null`. Les pairs
nous perdent dans le même tic de 50 ms, sans un chemin de code de plus. Le hub
n'a rien appris : pour lui, c'est une absence ordinaire.

Le réglage porte sur les **curseurs et la bulle qu'ils portent**. Le roster de la
barre du haut, les contours de pair (`useLiveOutline`) et « en train d'écrire »
restent actifs : ils disent où l'on est, pas où l'on pointe, et c'est la seconde
information qui pèse sur l'attention. La bulle, elle, est dessinée _dans_ le
curseur : la couper avec lui n'est pas un choix, c'est la même chose.

### Les tranches du magasin, et pourquoi elles existent

Le magasin de présence remplace son objet d'état à chaque poussée reçue — y
compris celles des curseurs, qui arrivent **jusqu'à vingt fois par seconde**
(`EMIT_FLOOR_MS`). Avec un unique `useLive()`, tout lecteur se réaffichait donc à
cette cadence, même s'il ne regardait que le roster : le portefeuille des
projets, les dépôts, les bases, les appareils se redessinaient entièrement dès
qu'un pair bougeait sa souris ailleurs dans l'espace. À l'écran, cela se voyait —
des trames qui sautent, un léger clignotement.

D'où trois vues étroites, à côté de `useLive()` :

| Hook                | Ce qu'il rend                | Qui s'en sert                                   |
| ------------------- | ---------------------------- | ----------------------------------------------- |
| `usePeers()`        | le roster seul               | la barre du haut (`usePresentUsers`)            |
| `useTeleportPath()` | la cible d'une téléportation | `useLiveSegment`, donc **toute** feature montée |
| `useLivePresence()` | `{ peers, path }`            | `useLiveOutlines`, donc toute liste entourée    |

La téléportation a deux clients : « rejoindre quelqu'un » (la bulle de la barre
du haut) et « Régler dans <espace> » (les réglages inertes d'un élément
projeté, `goToHome.ts`), qui y ajoute une intention `stores/settingsRequest`
consommée par le bouton de réglages commun une fois la fiche remontée.

`useSyncExternalStore` ne redessine que si l'instantané change au sens de
`Object.is`. Comme l'état est recopié **en surface**, `peers`, `path` et
`teleportPath` gardent leur identité d'une poussée de curseurs à l'autre : leurs
lecteurs ne bougent plus. `useLivePresence` doit en revanche rendre un objet, et
le mémorise donc — sans ce cache, chaque vérification en fabriquerait un neuf et
l'on retomberait sur un rendu permanent, ce qui serait pire que le mal.

> `useLive()` reste, mais **pour ce qui lit vraiment les curseurs** :
> `LiveCursors`, et rien d'autre. Se réafficher vingt fois par seconde est son
> travail.

---

## 5 bis. « En train d'écrire »

Une seconde voie rapide, jumelle de celle des curseurs, et **générique** : elle
ne dit pas _quoi_ est en train d'être écrit. La feature Projets s'en sert pour
les fils de discussion de ses cartes ; n'importe quelle autre peut s'en servir
sans toucher au moteur.

| Élément                                                                  | Où                                    |
| ------------------------------------------------------------------------ | ------------------------------------- |
| `LIVE_TYPING_COMMAND` = `live.typing`, trame `{ typing: boolean }`       | `DevEye-Types/src/features/live.ts`   |
| `LIVE_TYPERS_EVENT` = `live.typers`, poussée `{ workspaceId, typers[] }` | idem                                  |
| Voie rapide, à côté de celle du curseur                                  | `DevEye/src/ws/handler.ts`            |
| `typing()` sur `LiveTransport`, diffusion et péremption                  | `DevEye/src/live/hub.ts`              |
| `useTypingSignal()` / `useTypers()`                                      | `DevEye/client/src/live/useTyping.ts` |

**Hors du registre des commandes**, postée par `ws.post`, pour exactement la
raison écrite plus haut à propos des curseurs : `ws.send` y trouverait un
descripteur, ouvrirait une promesse en attente et armerait un délai de 15 s pour
une trame dont on n'attend aucune réponse.

**Même projection que les curseurs** : diffusée aux seuls pairs situés au
**chemin exactement identique**. Déclarer `useLiveSegment` suffit donc à cadrer
qui verra quoi — la trame ne porte aucun lieu, et l'espace de l'enveloppe est
ignoré comme sur la voie des curseurs.

### La péremption, et pourquoi elle existe

Sans elle, un onglet tué en pleine frappe laisserait « Untel est en train
d'écrire… » à l'écran indéfiniment. Le client réaffirme sa frappe toutes les
2,5 s ; passé 6 s sans nouvelle, le serveur cesse d'annoncer le pair.

Le balayage qui applique cette péremption **ne vit que pendant qu'on écrit** :
un seul minuteur pour tout le moteur, allumé à la première frappe et éteint dès
que plus personne n'écrit. C'est ce qui évite de payer une cadence permanente
pour un cas rare.

> ⚠️ L'anti-rebond du client (2,5 s) doit rester **nettement sous** la péremption
> du serveur (6 s), sinon l'indicateur clignoterait entre deux rappels.

---

## 5 ter. La bulle

Le texte libre qu'on écrit à son propre curseur, à la Figma. Une troisième voie
rapide, `live.say`, et le vocabulaire de l'interface est « bulle ».

De la présence, pas de la messagerie : rien n'est envoyé, rien n'est validé,
rien n'est stocké ni journalisé. Le texte vit tant que la saisie est ouverte, et
il meurt avec elle.

| Élément                                                              | Où                                           |
| -------------------------------------------------------------------- | -------------------------------------------- |
| `LIVE_SAY_COMMAND` = `live.say`, trame `{ message: string \| null }` | `DevEye-Types/src/features/live.ts`          |
| `LIVE_SAYS_EVENT` = `live.says`, poussée `{ workspaceId, says[] }`   | idem                                         |
| Voie rapide, à côté du curseur et de la frappe                       | `DevEye/src/ws/handler.ts`                   |
| `say()` sur le hub, diffusion par chemin                             | `DevEye/src/live/hub.ts`                     |
| Magasin et anti-rebond d'émission                                    | `DevEye/client/src/live/cursorChat.ts`       |
| Ma saisie, suspendue à mon curseur                                   | `DevEye/client/src/live/CursorChatInput.tsx` |
| La bulle du pair, sous son pseudo                                    | `DevEye/client/src/live/LiveCursors.tsx`     |

### Pourquoi un canal à part, et pas un champ du curseur

Le mettre dans `liveCursorSchema` était tentant : un champ, aucune plomberie.
C'est faux deux fois.

- **Ça fuirait par le roster.** `livePeerSchema` porte `cursor`, et le roster
  part à **tout l'espace** ; seul son `path` est tronqué par droits, parce que
  des coordonnées ne disent rien. Du texte, si. Un mot écrit dans le Coffre
  arriverait à qui n'a pas `read` dessus.
- **Ce n'est pas la bonne cadence.** La voie du curseur tourne à 20 Hz avec un
  plancher de 25 ms et un compteur de fautes qui **ferme la socket** au-delà de
  200 trames trop rapides.

### Pas de péremption, et c'est voulu

Contrairement à « en train d'écrire », rien n'expire côté serveur. La bulle
n'est dessinée qu'**à l'intérieur** du bloc de curseur d'un pair : pas de
curseur, pas de bulle. Elle hérite donc exactement de la durée de vie du
curseur, y compris quand un onglet meurt sans se fermer, où les deux restent
figés le même temps, jusqu'à la fermeture de socket. Un TTL n'aurait rien à
raccourcir.

### L'invariant des deux planchers, une troisième fois

Plancher serveur **100 ms** (`SAY_FLOOR_MS`) < cadence d'émission client
**150 ms** (`EMIT_FLOOR_MS` dans `cursorChat.ts`). Le sens est **l'inverse** de
celui de `live.changed` : là-bas la trame annonce un changement qu'une
re-sollicitation déjà programmée rattrapera, ici la trame **porte** l'état.
L'étouffer le perd au lieu de le retarder, et la dernière frappe resterait
invisible chez les pairs jusqu'à la suivante. D'où un anti-rebond client à front
arrière, copié de celui des positions de curseur, qui garantit que le dernier
état part toujours.

### La même boîte des deux côtés

Ce qu'on écrit doit avoir exactement la forme de ce que les autres lisent : même
largeur, même rembourrage, même corps, même interligne. Les mesures vivent donc
dans `client/src/Styles/live.css` (`--live-bubble-*`) plutôt que dans chacun des
deux modules CSS, où elles auraient dérivé, et un texte qui tient sur deux lignes
chez soi en tient deux en face.

La saisie est une zone de texte qui **grandit avec son contenu**, et non un champ
d'une ligne : sur une seule ligne, un texte un peu long fait défiler son propre
début hors de vue, et l'on écrit sans voir ce qu'on a écrit. Un retour à la ligne
est admis et se lit tel quel en face, la bulle étant en `pre-wrap`.

Deux détails qui ne s'héritent pas et s'écrivent donc à la main, comme partout
ailleurs dans le dépôt : la famille de caractères, qu'un contrôle de formulaire ne
prend pas du document, et la hauteur, que `scrollHeight` rend sans les bordures
que `border-box` compte.

**Grandir demande une borne.** `SAY_MAX_LENGTH` n'en est pas une : cent retours à
la ligne tiennent dans cent caractères, et la boîte descendait sous le bas de
l'écran. D'où `SAY_MAX_LINES`, appliqué à trois endroits qui se couvrent
mutuellement :

- le schéma, seul rempart d'une voie rapide qui court-circuite scope et audit ;
- le magasin, qui ramène le texte à ce plafond, collage compris ;
- la frappe, qui refuse la ligne de trop plutôt que de la retirer après coup. Sans
  elle, le magasin ne verrait aucun changement à annoncer, et le retour resterait
  dans le DOM d'un champ pourtant contrôlé.

### La position se lit, elle ne se recopie pas

La saisie suit le pointeur, mais sa position n'est mise en mémoire qu'**à partir
du premier mouvement** : tant qu'il n'a pas bougé, elle est lue au rendu.

Un état initialisé une fois pour toutes semblait plus simple, avec un effet pour
le rafraîchir à l'ouverture. Il est faux : un effet ne s'exécute qu'après la
première image, laquelle porte alors la position de la **fermeture précédente** et
saute à la bonne juste après. Mesuré à l'endroit où l'élément entre dans le DOM :
`translate(314px, 272px)` sur la première image contre `translate(914px, 622px)`
une fois stabilisée. C'est la même leçon que la géométrie de la surface au §5, et
elle se redéfait aussi facilement.

### L'ouverture, et la fermeture

La touche `/` hors de tout champ de saisie (premier raccourci à une touche du
client, posé dans `LiveProvider` faute de registre), plus un bouton dans le
widget « Présence » pour le faire découvrir. Échap passe par la pile de
`dismissLayer`, donc la bulle se ferme avant un dialogue ouvert dessous.

La saisie se ferme aussi **en perdant le focus** : cliquer ailleurs prend le
clavier, et une bulle qu'on ne peut plus modifier mais que les pairs voient
encore serait un piège. Elle se ferme enfin **au changement de lieu**, où le
serveur a de toute façon déjà effacé la bulle (`relocated`).

---

## 6. Points d'attention

- **`sessionId` n'identifie pas une socket.** C'est le `sid` du JWT, partagé par
  les onglets. L'identité d'une connexion est `connId` (uuid par socket). Les
  bulles se dédoublonnent par compte, les curseurs non.
- **Une salle par connexion, en déplacement et jamais en ajout.** `ws.send`
  estampille l'enveloppe à l'envoi et non à l'appel, donc un `live.here` resté en
  file peut arriver avec le nouvel espace ; un hub qui ajouterait sans retirer
  laisserait un fantôme permanent.
- **Le roster ne transporte pas les avatars.** `AVATAR_MAX_LENGTH` vaut 1,5 Mo et
  le roster repart à chaque changement de chemin. Il porte `userId` + couleur ; le
  reste se résout contre les membres que la session a déjà livrés. Seule la
  **couleur** voyage, parce qu'elle doit changer à l'instant.
- **La couleur passe par `colorChanged`, pas par `mutates`.** `user.setColor` est
  en `scope: 'account'` : sa diffusion `mutates` viserait l'espace personnel, où
  l'on est seul.
- **Le battement de cœur inscrit toute connexion `/ws`**, dès la poignée de main
  et avant tout `live.here` — sinon il ne couvrirait que les utilisateurs ayant
  ouvert une vue instrumentée.
- **La diffusion ne doit jamais lever.** Elle part de l'intérieur du `try` d'une
  commande déjà répondue : une exception y transformerait un succès en second
  message d'erreur. Chaque `socket.send` du hub est gardé individuellement.
- **L'état est local au processus**, comme `MonitorHub`. Deux instances derrière
  un proxy = salles scindées, en silence.
- **Espace personnel = salle d'une personne.** Le widget « Présence » n'y est pas
  seulement masqué : `availableTopbarWidgets` ne le **propose pas** au choix, et
  une disposition venue d'ailleurs qui le contiendrait ne l'afficherait pas
  davantage. Une seule fonction pour les trois usages — liste vivante, éditeur,
  dialogue d'ajout — pour que la règle ne puisse pas diverger entre eux. Curseurs
  et bordures s'y masquent aussi.

---

## 7. Vérifier

Trois scripts de protocole ont servi au chantier (25 assertions : roster,
troncature par droits, vues privées, curseurs, tentative de détournement par
l'enveloppe, expulsion immédiate, arborescence complète, battement de cœur). Ils
sont jetables et n'ont pas été conservés ; la recette utile est ailleurs :

- **Deux comptes, deux contextes de navigateur isolés** (`Target.createBrowserContext`
  en CDP), pas deux profils.
- **Fermer les onglets à la fin.** Un onglet resté ouvert d'un essai précédent est
  une connexion de plus dans la salle et fausse toute lecture — deux `connId` pour
  le même compte est le symptôme.
- **Le rate-limit coupe au bout de quelques rechargements** : `RATE_LIMIT_MAX`
  haut sur le serveur de test.
- **La disposition d'accueil vient du serveur** et écrase le `localStorage` :
  pour épingler le widget « Présence » dans un test, semer `workspaces.home_layout`
  en base.
- Et la règle du dépôt : **regarder la capture**. Les curseurs manquants n'ont été
  vus que là.
