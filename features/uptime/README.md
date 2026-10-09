# Uptime : le suivi de disponibilité

Uptime surveille des services HTTP : des sondes périodiques côté serveur, un
historique long terme, des incidents, des notifications et des pages de statut
publiques. C'est une feature de grille (carte d'accueil + panneau) plus un
widget de barre supérieure.

Documents voisins : [Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md)
(la section « Uptime »), [Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md),
[Docs/SHARING.md](../../Docs/SHARING.md), [Docs/FEDERATION.md](../../Docs/FEDERATION.md),
[Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md).

## Le modèle

Un **service** est une URL et une cadence : la sonde vérifie que le site
répond et, quand son option d'intégrité est cochée, qu'il sert encore les
mêmes fichiers. Il appartient à l'espace et se partage entre espaces comme les
autres éléments de premier rang (`shareTier: 'open'`) : le module tient
l'engagement par son entrée `items` (domicile, intitulé, déplacement, copie),
par `ctx.sharing.scope()` dans ses listages et par `ctx.items.restrictions()` /
`ctx.items.assert()` (les restrictions par élément), `ctx.items.forget()`
faisant le ménage à la suppression. Un projet relie un service par
`project_uptime_links` (table de Projets, qui ne stocke que des identifiants et
interroge `UPTIME_ITEMS_PROVIDER` avant de relier).

Tout ce que l'ordonnanceur lit pour **planifier** une sonde (cadence, délai,
seuil, actif) et tout ce qu'un graphique agrège (statut, latence, horodatages)
vit en colonnes claires ; ce qui identifie la cible (nom, URL, mot-clé, chemins
d'intégrité), la référence et le verdict d'intégrité et les messages d'erreur
sont chiffrés à l'**étage ouvert**, puisque le vérificateur tourne en tâche de fond, sans
session ni mot de passe. Aucune commande n'est verrouillée par le chiffrement
par mot de passe : la feature s'ouvre et se lit sans prompt.

Sept tables : quatre du socle (`uptime_services`, `uptime_checks`,
`uptime_daily`, `uptime_incidents`, dispensées du préfixe par l'allowlist de
`deveye-feature.json`) et trois du module au préfixe `ft_uptime_` (les pages de
statut, `src/server/migrations/001_status_pages.sql`, et le journal des
intégrités, `004_integrity_readings.sql`). Les migrations `002_integrity.sql` et
`003_integrity_option.sql` du module ajoutent à `uptime_services` les colonnes
de l'option d'intégrité.

## Le principe

Chaque service est une URL et une cadence. Un ordonnanceur unique
(`src/server/service.ts`, le service de fond du module) se réveille toutes les
`UPTIME_TICK_SECONDS` (10 s), réclame les services dont la prochaine sonde est
due (huit par place de concurrence) et les exécute en pool,
`UPTIME_CONCURRENCY` (16) en vol à la fois, une sonde lente n'occupant que sa
place. Un tour part aussi au démarrage, pour qu'un redémarrage ne fasse pas
attendre les services. Un service n'est jamais sondé deux fois à la fois : un
`uptime.checkNow` qui tombe sur un tour planifié rejoint la sonde en cours.

Une sonde est réussie si :

1. le statut HTTP correspond (`expected_status` exact, sinon n'importe quel
   2xx/3xx) ; **et**
2. le corps contient le mot-clé attendu, quand il y en a un (le corps n'est lu
   que dans ce cas, 512 Kio au plus ; sinon la connexion est relâchée
   immédiatement) ; **et**
3. avec l'option d'intégrité, aucun écart ni fichier illisible ne tient le
   service en échec (section suivante).

Un échec isolé ne fait pas une panne : le service ne bascule `down` qu'après
`failure_threshold` échecs consécutifs (2 par défaut, 10 au plus). Les bornes
d'un service : cadence de 30 s à 24 h, délai de 1 à 120 s (10 s par défaut).
Sans cadence donnée, un service neuf prend celle de l'offre du propriétaire de
l'espace (`UPTIME_DEFAULT_INTERVAL_SECONDS` : 60 s payé, 300 s gratuit).

Les appels sortants passent par le garde `safeFetch` de l'app
(`src/Services/netFetch.ts`) : une adresse privée ou locale est refusée à la
création comme à la sonde, sauf si l'installation ouvre son réseau privé avec
`OUTBOUND_ALLOW_PRIVATE`.

## L'option d'intégrité

Une case des réglages d'un service, décochée par défaut, ajoute à « le site
répond-il ? » une seconde question : « **sert-il encore les mêmes fichiers ?** ».
Le JavaScript qu'une page charge est ce qui tient les sessions de ses
visiteurs : un serveur compromis qui le modifie touche tout le monde, et
personne ne le voit. Un vérificateur qui vit sur ce serveur ne vaut rien,
l'attaquant le remplace avec le reste. Celui-ci vit **ailleurs** : sur une
autre instance DevEye. L'adresse du service doit alors être une page du site,
pas un point de santé, qui ne charge aucun script.

Relire tout un site coûte des centaines de requêtes : les fichiers ne se
relisent pas à chaque sonde. L'option a son propre rythme
(`integrity_interval_seconds` : 5 min, 15 min par défaut, 1 h, 6 h ou 1 jour,
jamais sous `UPTIME_INTEGRITY_INTERVAL_MIN`), et la lecture se greffe sur la
première sonde où elle est due (`integrityDue`), une fois la requête principale
réussie. « Tester » et « Accepter la version actuelle » la forcent.

À chaque lecture (`src/server/integrity.ts`), la sonde :

1. lit le document (statut, et son en-tête `Content-Security-Policy`) ;
2. établit la liste des fichiers : le **manifeste de build** du site s'il en
   publie un (`/.well-known/deveye-build.json`, ce que fait toute instance
   DevEye : chaque fichier de son client, morceaux chargés à la demande
   compris), sinon les scripts, feuilles de style et préchargements de même
   origine trouvés dans la page ; plus les chemins ajoutés à la main (`/t.js`,
   50 au plus) ;
3. relit chaque fichier, empreinte SHA-256 calculée en flux (8 Mo au plus par
   fichier, 400 fichiers au plus, quatre à la fois) ;
4. compare à la **référence** (`baseline_enc`, chiffrée à l'étage ouvert).

Le manifeste n'est pas la référence : un serveur compromis le réécrirait. La
référence est **apprise** ici, à la première lecture réussie, manifeste compris.

Le service garde **une seule courbe**, celle de la requête principale, que les
fichiers influencent (`applyIntegrity` dans `src/server/service.ts`, pure) :

- **Un écart** (fichier modifié, ajouté, retiré, politique changée) pose un
  verdict (`integrity_verdict`, chiffré à l'étage ouvert) qui tient **chaque**
  mesure en échec, lecture ou pas, jusqu'à ce qu'une lecture retrouve la
  référence ou que l'utilisateur accepte la version actuelle. Sans lui, la
  sonde suivante, verte, refermerait la panne. `failure_threshold` s'applique
  comme à toute panne : l'incident s'ouvre à la sonde qui suit l'écart, nomme
  les fichiers et part en alerte `integrity`.
- **Une lecture ratée** (statut d'un fichier, délai, `429`, liste trop longue)
  fait échouer sa mesure, avec une erreur qui commence par « Fichiers : », et
  se retente cinq minutes plus tard plutôt qu'au rythme choisi. Au bout de
  `failure_threshold` lectures ratées d'affilée (`integrity_failures`), elle
  devient verdict à son tour : un `429` isolé ne laisse qu'une barre jaune, un
  script durablement absent met le service en panne.
- **La latence** d'une mesure avec lecture est la plus longue entre la requête
  principale et le fichier le plus lent : un site sain n'y voit rien, un script
  qui traîne fait monter la courbe.

Après un déploiement voulu, « Accepter la version actuelle »
(`uptime.acceptBaseline`) oublie la référence et le verdict, puis relit : ce
que le site sert à cet instant devient la référence, et l'incident se referme
par le chemin ordinaire, « rétabli » compris. Cocher ou décocher l'option,
changer l'adresse ou la liste des chemins fait de même (`resetIntegrity`).

Chaque lecture s'inscrit au **journal des intégrités**
(`ft_uptime_integrity_readings`) avec son constat : référence apprise,
conforme, écart ou lecture ratée, le nombre de fichiers comparés et le plus
lent. Le détail d'un écart (fichier par fichier) ou la raison d'une lecture
ratée y est chiffré à l'étage ouvert (`detail`). Une sonde qui ne relit pas les
fichiers n'y laisse rien.

Ce qu'elle voit et ne voit pas :

- **Détecter, pas empêcher** : une attaque plus courte que le rythme de lecture
  (cinq minutes au plus vite) passe entre deux lectures.
- Une page servie **différemment selon le visiteur** (adresse, session) n'est
  pas couverte : la sonde est anonyme, depuis l'adresse de l'instance qui la
  porte.
- Une ressource d'une **autre origine** (CDN) n'est pas relue : ce serait
  mesurer un autre serveur.
- Le repli SPA d'un serveur répond `index.html` à un chemin disparu : l'écart
  se voit à l'empreinte, jamais au statut.
- Une lecture sur une instance DevEye fait autant de requêtes qu'elle a de
  fichiers, et le limiteur de débit de l'instance sondée (`RATE_LIMIT_MAX`,
  200 par minute et par adresse par défaut) peut en refuser : un fichier refusé
  (`429`) fait une lecture ratée, jamais un fichier modifié. D'où le rythme de
  cinq minutes au plus vite, et un « Tester » juste après une lecture qui peut
  tomber sur ce refus.

**Surveillance mutuelle** : chaque instance surveille l'autre, option
d'intégrité cochée, sans rien de spécial. Un sens ne marche pas : depuis une
instance publique vers une instance derrière un VPN, `safeFetch` refuse
l'adresse privée (sans `OUTBOUND_ALLOW_PRIVATE`). L'inverse (l'instance privée
surveille l'instance hébergée) est le sens utile, et celui qui protège les
sessions distantes ([Docs/FEDERATION.md](../../Docs/FEDERATION.md)).

## Les trois niveaux d'historique

| Table                          | Contenu                     | Purge                                                        |
| ------------------------------ | --------------------------- | ------------------------------------------------------------ |
| `uptime_checks`                | chaque ping                 | `retention_days` du service (90 j par défaut, `NULL` = tout) |
| `ft_uptime_integrity_readings` | chaque lecture des fichiers | `retention_days` du service, comme les pings                 |
| `uptime_daily`                 | agrégat par jour UTC        | **jamais**                                                   |
| `uptime_incidents`             | pannes (début / fin)        | **jamais**                                                   |

C'est ce découpage qui tient la promesse « remonter des mois ou des années » :
l'agrégat journalier est écrit dans le même souffle que le ping brut
(`INSERT … ON DUPLICATE KEY UPDATE`, donc toujours en phase, sans job
d'agrégation à orchestrer), et il survit à l'élagage du brut. Réduire la
rétention ne coûte que le détail ping par ping : la courbe de disponibilité,
elle, reste complète.

L'élagage est un second ticker du service du module, lancé au démarrage puis
toutes les heures.

`uptime.history` choisit le pas depuis la fenêtre demandée : brut jusqu'à 24 h,
horaire jusqu'à 30 j (`GROUP BY` sur le brut), journalier au-delà (lecture
directe de `uptime_daily`). Un graphique « 1 an » coûte donc ~365 lignes.

Les taux affichés dans la liste suivent la même logique : 24 h calculé sur le
brut (exact à la seconde), 7 j / 30 j sur l'agrégat journalier, donc en jours
UTC pleins, la convention usuelle, et toujours disponible même avec une
rétention courte.

## Incidents et notifications

Une panne est matérialisée : incident ouvert au franchissement du seuil, fermé
à la première sonde réussie. Il y a **au plus un incident ouvert par service**,
et c'est ce qui rend les alertes exactement-une-fois : une alerte appartient à
un incident, pas à une sonde.

- **Hors ligne** (`down`) → alerte avec l'heure de bascule et l'erreur ;
  l'incident est marqué `notified` si un canal l'a acceptée.
- **Fichiers modifiés** (`integrity`) → alerte qui nomme les fichiers, avec le
  rappel d'« Accepter la version actuelle » si c'est un déploiement voulu. Des
  fichiers illisibles au seuil partent en « hors ligne », leur erreur à
  l'appui.
- **Retour en ligne** (`recovered`) → alerte avec la durée de la panne et sa
  cause initiale, **seulement si** la bascule avait bien été notifiée (sinon on
  enverrait un « c'est revenu » sans contexte).

Les canaux sont ceux de l'espace, désignés par une **route**
([Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md) porte le modèle
complet) ; ce qui compte ici :

- un service peut avoir **ses propres canaux** (`notify.send(…, { itemId })`
  active la route propre au service) ; sans réglage propre il suit ceux
  d'Uptime. C'est ce qui permet d'envoyer les alertes de deux services à deux
  équipes différentes ;
- **e-mail** : destinataire libre, vide = l'adresse du compte expéditeur, qui
  doit être un compte Mail de l'espace (le manifest déclare le lien
  `links: [{ to: 'mail' }]`) ;
- **webhook** : POST JSON `{ content, text, event, service, url, at }`, où
  `event` vaut `down`, `recovered` ou `integrity` (l'essai d'un canal passe par
  `notify.channelTest`, avec son propre corps, commun à tous les émetteurs). Le
  message lisible est porté **deux fois**, et c'est voulu : Discord rejette
  tout corps sans `content` / `embeds` / `file` et Slack lit `text`. Chacun
  ignore les clés qu'il ne connaît pas, donc un seul corps convient à Slack et
  à un point d'entrée maison. Le texte est tronqué à 1900 caractères
  (`WEBHOOK_TEXT_MAX`), sous la limite de 2000 de Discord ;
- **discord** : un type de canal à part entière, **déclaré** et non deviné
  d'après l'URL ; il reçoit l'embed de `src/server/notice.ts` au lieu du texte.

Le bouton « Tester » agit **par canal**, sur la ligne telle qu'elle est
enregistrée. L'écran de réglage est `Components/FeatureSettings/` de l'app,
partagé par toutes les fonctionnalités qui notifient et par leurs éléments.

Chaque bascule est aussi journalisée dans les logs d'audit (`uptime.down`,
`uptime.integrity`, `uptime.recovered`), comme chaque réglage (`uptime.add`,
`uptime.update`, `uptime.remove`, `uptime.baselineAccepted`), donc consultable
dans la page Journaux.

## Les deux graphiques

Le panneau de détail superpose deux lectures de la **même** fenêtre, sur le même
axe des x (`rangeWindow()` dans `src/client/format.ts`) :

- la **bande d'état** (`StatusBars`) : un nombre _fixe_ de créneaux découpant la
  période choisie, vert / jaune / rouge / gris (aucune mesure). Une barre
  représente une tranche de temps, pas un échantillon : la bande a donc la même
  allure avec dix mesures ou cent mille, et un service ajouté il y a dix minutes
  affiche bien 24 h de gris derrière ses premiers points ;
- la **courbe de latence** (`UptimeChart`), avec les créneaux en échec ombrés
  derrière elle.

L'axe est la **durée sélectionnée**, jamais l'étendue des données : les deux
blocs s'alignent colonne par colonne, et un trou de surveillance se voit comme
un trou. Le seuil « lent » (jaune) est relatif à la médiane du service (2×,
plancher `SLOW_FLOOR_MS` de 150 ms) : un endpoint à 20 ms et un à 400 ms sont
tous deux normaux.

La bande d'état sert trois endroits, en deux formes. `full` (sous un titre,
avec sa légende) dans le détail d'un service et dans l'onglet Uptime d'un
projet, où les trois pourcentages se posent en face de la légende
(`trailing`). `inline` (plus basse, sans légende) dans chaque ligne de la
liste : répétée vingt fois, une légende pèserait plus que les barres, et la
**bulle de survol** dit déjà ce qu'elle dirait. Cette bulle remplace l'attribut
`title` : l'infobulle native se fait attendre une seconde et ne désigne jamais
_quelle_ barre elle décrit, ce qui est précisément la question sur des tranches
de trois pixels.

## Les trois étages du panneau

`liste des services` → `détail d'un service` → `journal des mesures`, chacun
remplaçant le précédent avec un bouton retour.

**La liste se lit, elle ne pilote pas.** Chaque ligne porte le nom, l'état, la
bande des dernières 24 h et les trois pourcentages. Rien d'autre : « tester »
et « mettre en pause » sont des gestes rares, et vivent là où l'on se rend pour
les faire : la fiche du service porte « Tester », ses réglages portent la
pause. Toute la ligne mène à la fiche, barres comprises : repérer un creux
rouge et vouloir l'ouvrir est le même geste.

Tout ce qui se règle sur un service vit dans ses **réglages** (le bouton commun
de sa fiche, onglet Général : `ServiceGeneralPanel`, déclaré par
`settings.item` du manifest) : son identité (nom, URL, méthode, statut
attendu, mot-clé, option d'intégrité avec son rythme et ses chemins,
surveillance active), sa fréquence de relève, son délai, ses échecs consécutifs avant alerte, sa conservation de
l'historique détaillé et sa suppression, à côté de ses canaux, de son partage
et de ses permissions. Le panneau envoie le service entier à `uptime.update`,
dont le contrat prend tout. Le dialogue (`ServiceDialog`) ne sert qu'à
**ajouter** un service : il demande l'identité et pose les réglages fins par
défaut ; c'est aussi lui que l'onglet Uptime d'un projet ouvre, par le contrat
client.

Le journal complet a son propre étage (`MeasuresBrowser`) parce qu'un an de
sondes fait des dizaines de milliers de lignes : en ligne dans le détail, il
enterrerait les graphiques. Le détail n'en montre donc que les **8 dernières**
(`CHECKS_PREVIEW`) et les 20 derniers incidents. Les mesures tiennent dans un
panneau qui occupe la moitié gauche de la fiche ; avec l'option d'intégrité, le
journal des intégrités (`IntegrityJournal`, `uptime.integrityReadings`) prend
la moitié droite, 8 lectures à la fois et « Charger plus » pour remonter. Sur
un téléphone, les deux panneaux s'empilent. « Voir toutes les mesures » mène à
l'étage du dessous, qui offre des filtres (période, échecs seulement), des agrégats
(`uptime.checkStats`, calculés sur toute la sélection et pas sur la page
chargée) et une liste qui défile **dans sa propre boîte** : le panneau autour
ne s'allonge jamais.

`uptime.checks` et `uptime.checkStats` partagent le même schéma de filtre, pour
qu'une page et ses agrégats décrivent toujours exactement la même sélection. Les
agrégats sont une commande à part et non un champ de sortie : ils balayent toute
la plage filtrée, et l'aperçu du détail n'a pas à payer ce coût.

## Rafraîchissement sans à-coup

Les blocs se re-interrogent à chaque sonde. Plutôt que de remplacer leur contenu
par un « Chargement… », ce qui ferait s'effondrer puis rebondir la mise en page,
chacun est enveloppé dans `Pane` : le dernier contenu connu reste monté à sa
taille exacte, atténué, avec un spinner centré par-dessus. Les graphiques, les
incidents et le journal ont chacun leur propre état de chargement et se mettent
donc à jour indépendamment.

Rien n'est sondé côté client : le service de fond diffuse `live.changed` à
chaque **transition d'état** (jamais à chaque sonde), ce qui ravive
`uptime.count` et `uptime.list` ; la carte d'accueil et le widget de barre
lisent le même magasin (`store.ts`), d'une seule requête. Retoucher une page de
statut ne ravive que `uptime.pageList` (sujet `uptimePages`), et un domaine
vérifié ou retiré la ravive aussi (`alsoInvalidatedBy: domain`).

## Ordre d'affichage

L'ordre est **entièrement défini par l'utilisateur**, par glisser-déposer, comme
pour les notes. Rien ne repositionne un service automatiquement : seuls
`uptime.reorder` et l'ajout d'un service (qui prend le rang suivant, donc la fin
de la liste) touchent à `sort_order`. Un tri automatique par urgence et un
ordre choisi ne peuvent pas coexister : un ordre qui se réarrange tout seul
sous le curseur n'est pas un ordre.

Le geste vit dans `useDragReorder` du SDK client (`client/src/dragReorder.ts`
de l'app, exporté par `deveye-sdk-client`) ; `ServiceList` ne garde que la
carte, sa poignée et la barre d'insertion. Le hook travaille aux **Pointer
Events** et non à l'API HTML5 `draggable` : une pression devient un glissé
au-delà de 6 px, Echap l'annule, et tout l'état reste dans des refs du
composant, jamais dans la machine à états DnD du navigateur, dont une session
interrompue peut laisser toute la page croire qu'un glissé est encore en cours.
La barre d'insertion est **pilotée par le DOM, jamais par un état React** :
elle se place au milieu réel du créneau, mesuré sur les deux lignes qui le
bordent. Le rafraîchissement périodique est suspendu pendant un glissé, sinon
la liste se réordonnerait sous le curseur. Seule la poignée refuse le
défilement tactile (`touch-action: none`) : un glissement commencé ailleurs
fait toujours défiler la liste.

## Pages de statut

Une page publique, lisible sans compte, qui montre quelques services de
l'espace (30 au plus) : l'état de chacun, 90 barres journalières
(`UPTIME_PAGE_DAYS`), sa disponibilité sur 90 jours, les pannes en cours et
celles des 30 derniers jours (20 au plus), et sur demande le temps de réponse
des dernières 24 h. Elle se règle dans l'onglet « Pages de statut » des
réglages de la feature (`StatusPagesPanel`, `StatusPageDialog`), et vit dans
`ft_uptime_pages` et `ft_uptime_page_services`.

- **Ce qui ne sort jamais.** L'adresse sondée et le mot-clé attendu. Le nom
  d'un service peut être remplacé par un nom public. La nature d'une panne ne
  se montre que si la page le demande (`showErrors`), et seulement en catégorie
  (`publicReason` : « Réponse HTTP n », « Délai de réponse dépassé »,
  « Contenu inattendu », « Intégrité des fichiers compromise », « Fichiers du
  site indisponibles », « Connexion impossible »), jamais le message de la sonde, qui trahirait le réseau
  interne.
- **Les services de son espace seulement.** Un service projeté d'ailleurs
  n'est pas le sien à exposer ; déplacé dans un autre espace, un service
  quitte les pages de celui qu'il quitte (`move.ts` le déclare dans ses
  `drops`).
- **Les barres.** Un jour est rouge dès qu'une panne l'a touché, jaune si des
  sondes ont échoué sans franchir le seuil de panne, gris sans mesure : le
  public voit les pannes, pas chaque sonde manquée que la bande de l'écran
  montre.
- **L'adresse.** `/statut/<lien>` sous l'origine publique, un lien de 16
  caractères hexadécimaux tiré au hasard. Sous un domaine client vérifié
  (onglet Domaines, `domains.web`), la page répond à la racine du nom, par
  `domainRoot` : un domaine sert une page. Une page ne se montre que sous
  l'adresse de DevEye ou sous un domaine de son propre espace. Désactivée, ou
  en pause par l'offre, elle répond « introuvable ».
- **Le coût.** Une page se calcule au plus une fois toutes les trente secondes
  (`CACHE_MS`), un calcul à la fois (`statusPage/routes.ts`), et la route est
  plafonnée à 300 requêtes par minute et par adresse : une panne attire tout le
  monde au même moment, et c'est alors que la base doit rester libre pour les
  sondes.
- **Le document.** Du HTML rendu au serveur, sans ressource distante, avec sa
  propre politique de contenu (`frame-ancestors *` : intégrable en iframe) et
  ses propres couleurs (`statusPage/style.ts`), en thème `auto`, `light` ou
  `dark`. Un petit script servi à part (`/statut/page.js`) relit la page toutes
  les minutes et remet les heures dans le fuseau du visiteur ; sans lui, la
  page reste lisible en UTC. « DevEye » au pied de la page mène au site vitrine
  de l'instance (`ctx.origins.site`, soit `SITE_URL`) ; sans site, le nom
  reste, sans lien.

La vérification d'un domaine pour une page passe par `src/server/domains.ts` :
le socle a vu le nom pointer ici et répondre en HTTPS, le module confirme que
c'est bien cette installation qui répond, par le jeton que la route publique
`/.well-known/deveye-uptime` rend sous ce nom.

## Partage, déplacement, copie

`items.homeOf` et `items.labelOf` disent au partage, aux routes de
notification et au déplacement ce qu'ils doivent savoir d'un service sans
ouvrir la feature. `move.ts` change le domicile d'un service et rescelle tout
ce qui pend à lui sous la clé du nouvel espace (`copy.ts` porte l'arbre des
colonnes scellées, la seule liste à tenir) ; un service est autonome (il porte
son URL, aucun nom unique par espace), donc aucun refus à déclarer, seulement
le retrait de ses pages de statut. `uptime_daily` n'est pas dans l'arbre : elle
n'agrège que des nombres.

## Commandes

`uptime.list` · `uptime.count` · `uptime.add` · `uptime.update` ·
`uptime.setEnabled` · `uptime.remove` · `uptime.reorder` · `uptime.checkNow` ·
`uptime.acceptBaseline` · `uptime.history` · `uptime.checks` ·
`uptime.checkStats` · `uptime.incidents` · `uptime.pageList` ·
`uptime.pageAdd` · `uptime.pageUpdate` · `uptime.pageRemove`

Dix-sept commandes, déclarées par `src/contracts/commands.ts` et enregistrées
au démarrage comme celles de tout module. `uptime.checkNow` emprunte le chemin
de l'ordonnanceur (`monitor().runOne`), donc un test manuel compte dans
l'historique, l'agrégat et les incidents exactement comme une sonde
automatique ; la pause choisie ne l'empêche pas, celle de l'offre si.

## Carte du code

### Le module : `features/uptime/`

```
package.json, deveye-feature.json    deveye-feature-uptime ; allowlist des 4 tables du socle
src/index.ts                         manifest + contrats (l'entrée isomorphe)
src/manifest.ts                      featureDescriptor('uptime') étalé ; resources, topics, quotas, domains,
                                     topbarWidget, settings (pages, domains ; item general)
src/contracts/domain.ts              service, contrôle, incident, point, page de statut, lignes SQL, bornes
src/contracts/commands.ts            les dix-sept commandes
src/contracts/format.ts              mise en forme partagée client / serveur
```

`@deveye/types` ne garde que l'identité (id, descripteur, sujet live, émetteur
de notifications) et les deux contrats de couplage que Projets consomme
(`sdk/providers.ts` : `UPTIME_ITEMS_PROVIDER`, `UPTIME_CLIENT_PROVIDER`).

### Serveur : `features/uptime/src/server/`

```
index.ts          serverEntry : env, createRepo, features, migrationsDir, domains, quotas (monitors, pages),
                  createService (ordonnanceur + pages de statut + provider + publicRoutes + domainRoot +
                  onPlanPause), items (homeOf, labelOf, move, copy), accountExport, e2e
env.ts            UPTIME_TICK_SECONDS, UPTIME_CONCURRENCY (defineModuleEnv)
repo.ts           UptimeRepo : `services` et `history`, composés avec `pages` et `status`
repoPages.ts      les pages de statut : réglage, et lectures groupées de la page publique
_shared.ts        Ctx, le singleton de l'ordonnanceur et des pages, le chiffrement d'un service, publicReason,
                  STATUS_PATH
service.ts        UptimeMonitor : tick, pool, sonde HTTP, lecture des fichiers (integrityDue, applyIntegrity),
                  enregistrement, incidents, alertes, élagage horaire, fermeture des pannes d'un service mis
                  en pause
integrity.ts      captureSite, diffCapture, describeDrift : la lecture des fichiers, pure, réseau injecté
notice.ts         la mise en page Discord d'une alerte (down, recovered, integrity)
handlers.ts       les quatorze commandes des services
pages.ts          les quatre commandes des pages de statut
domains.ts        la vérification d'un domaine (jeton sous /.well-known/deveye-uptime), onRemoved
statusPage/       routes.ts (cache, débit, domainRoot), view.ts (le modèle de la page), render.ts, html.ts,
                  style.ts, script.ts (/statut/page.js)
copy.ts           uptimeTree : ce dont un service est fait (colonnes scellées), la copie
move.ts           le changement d'espace d'un service
accountExport.ts  l'export des données du compte, table par table
e2e.ts            le scénario de bout en bout : surveiller ce serveur même, tester, lire le verdict
uninstall.sql     démonte les trois tables ft_uptime_*
migrations/       001_status_pages.sql, 002_integrity.sql, 003_integrity_option.sql,
                  004_integrity_readings.sql
*.test.ts         handlers, service, integrity, notice, pages, repo, move, accountExport,
                  statusPage/routes, statusPage/view
```

### Client : `features/uptime/src/client/`

```
index.tsx              clientEntry : Widget, Full, TopbarWidget, settingsPanels (general, pages), providers
Uptime.tsx             la vue complète : liste, fiche, journal
ServiceList.tsx        la liste et le glisser-déposer (useDragReorder)
ServiceCard.tsx        une ligne : état, bande 24 h, taux ; toute la ligne ouvre la fiche
ServiceDetail.tsx      la fiche : graphiques, référence d'intégrité, incidents, aperçu du journal, « Tester »
IntegrityJournal.tsx   le journal des intégrités, à droite des mesures quand l'option est cochée
MeasuresBrowser.tsx    le journal complet : filtres, agrégats, défilement dans sa boîte
StatusBars.tsx         la bande d'état (full / inline, trailing), le seuil « lent »
UptimeChart.tsx        la courbe de latence, créneaux en échec ombrés
Ratios.tsx             les trois taux, toujours les trois et dans cet ordre
Pane.tsx               le bloc qui se recharge sur place
ServiceDialog.tsx      ajouter un service ; les réglages fins partent avec leurs défauts
ServiceGeneralPanel.tsx  onglet Général d'un service : identité, réglages fins, suppression
StatusPagesPanel.tsx   onglet « Pages de statut » de la feature
StatusPageDialog.tsx   créer ou régler une page
TopbarWidget.tsx       le widget de barre, sans prop : tout vient du magasin
UptimeWidget.tsx       la carte d'accueil
store.ts               le magasin « en ligne / total », partagé par la carte et le widget
useServiceHistory.ts   l'historique d'un service, pour qui n'affiche que la bande d'état
provider.tsx           UPTIME_CLIENT_PROVIDER : bande d'état, taux, historique, dialogue d'ajout pour Projets
api.ts  format.ts  style.module.css
```

### Ce qui reste dans l'app

```
src/db/migrations/037_uptime.sql (+ 038, 049, 090)   les quatre tables du socle
src/db/migrations/133_pin_collation.sql              épingle ces tables en utf8mb4_general_ci
src/Services/netFetch.ts                             safeFetch, isAllowedOutboundUrl (le garde des appels sortants)
src/Services/alertCore.ts, notices/shared.ts         horodatages, durées, helpers Discord partagés
client/src/dragReorder.ts                            useDragReorder (exporté par deveye-sdk-client)
client/src/Components/FeatureSettings/               l'écran de réglage commun (canaux, partage, permissions)
features/projects/src/client/Uptime/                 l'onglet Uptime d'un projet, par UPTIME_CLIENT_PROVIDER
```

## Configuration

Lues par le module lui-même (`src/server/env.ts`, `defineModuleEnv`), pas par
`Utils/Env`, et nommées au démarrage si elles restent à leur défaut :

| Variable              | Défaut | Rôle                                                                 |
| --------------------- | ------ | -------------------------------------------------------------------- |
| `UPTIME_TICK_SECONDS` | `10`   | la cadence à laquelle l'ordonnanceur cherche les services dus        |
| `UPTIME_CONCURRENCY`  | `16`   | combien de sondes sont en vol à la fois (une sonde attend le réseau) |

Du socle (`src/Utils/Env.ts`) :

| Variable                 | Défaut  | Rôle                                                          |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `OUTBOUND_ALLOW_PRIVATE` | `false` | autoriser les sondes vers une adresse privée ou locale        |
| `PUBLIC_ORIGIN`          |         | l'adresse sous laquelle `/statut/<lien>` répond               |
| `SITE_URL`               | vide    | le site vitrine vers lequel le pied d'une page de statut mène |

## Les quotas de l'offre

Deux clés déclarées par le manifest, bornées par le module de facturation des
comptes (`DevEye-Billing/src/server/plans.ts`) :

| Clé               | Ce qu'elle compte           | Gratuite | Pro |
| ----------------- | --------------------------- | -------- | --- |
| `uptime.monitors` | services surveillés (stock) | 5        | 50  |
| `uptime.pages`    | pages de statut (stock)     | 1        | 10  |

Au-delà d'une limite de stock, l'hôte met les plus récents en **pause**
(`planPaused`) sans que `enabled`, le choix de l'utilisateur, ne bouge : un
service en pause n'est ni sondé ni testé, et sa panne en cours se ferme
(`onPlanPause` → `closeOutages`), sans quoi la page publique la dirait « en
cours » et sa durée courrait sans que personne ne mesure plus rien ; une page
en pause répond « introuvable ». La cadence par défaut d'un service neuf suit
aussi l'offre (60 s payé, 300 s gratuit). Une installation sans module de
facturation n'a aucune limite.

## Tests

```bash
cd DevEye
npm run test:features
```

Le scénario `e2e.ts` (page Tests et débogage, [Docs/DEBUG.md](../../Docs/DEBUG.md))
crée une surveillance de ce serveur même, la teste à la demande, lit le verdict
et la supprime ; il se saute de lui-même quand l'adresse du serveur est privée.
