# Uptime — suivi de disponibilité

Surveillance de services HTTP : sondes périodiques côté serveur, historique
long terme, incidents et notifications. Feature de grille (carte d'accueil +
panneau) plus un mini-widget de topbar.

## Le principe

Chaque service est une URL et une cadence. Un ordonnanceur unique
(`src/Services/UptimeMonitor.ts`) se réveille toutes les `UPTIME_TICK_SECONDS`,
réclame les services dont la prochaine sonde est due et les exécute
`UPTIME_CONCURRENCY` à la fois. Il tourne **sans session ni mot de passe** : voir
la section « Uptime » de [SECURITY_MODEL.md](./SECURITY_MODEL.md) pour ce qui est
chiffré et ce qui reste en clair.

Une sonde est réussie si :

1. le statut HTTP correspond (`expected_status` exact, sinon n'importe quel
   2xx/3xx) ; **et**
2. le corps contient le mot-clé attendu, quand il y en a un (le corps n'est lu
   que dans ce cas — sinon la connexion est relâchée immédiatement).

Un échec isolé ne fait pas une panne : le service ne bascule `down` qu'après
`failure_threshold` échecs consécutifs.

## Les trois niveaux d'historique

| Table              | Contenu                    | Purge                                     |
| ------------------ | -------------------------- | ----------------------------------------- |
| `uptime_checks`    | chaque ping                | `retention_days` du service (NULL = tout) |
| `uptime_daily`     | agrégat par jour UTC       | **jamais**                                |
| `uptime_incidents` | pannes (début / fin)       | **jamais**                                |

C'est ce découpage qui tient la promesse « remonter des mois ou des années » :
l'agrégat journalier est écrit dans le même souffle que le ping brut
(`INSERT … ON DUPLICATE KEY UPDATE`, donc toujours en phase, sans job d'agrégation
à orchestrer), et il survit à l'élagage du brut. Réduire la rétention ne coûte
que le détail ping par ping — la courbe de disponibilité, elle, reste complète.

L'élagage tourne dans le balayage horaire de `index.ts`, aux côtés de celui des
métriques et de CloudSync.

`uptime.history` choisit le pas depuis la fenêtre demandée : brut jusqu'à 24 h,
horaire jusqu'à 30 j (`GROUP BY` sur le brut), journalier au-delà (lecture
directe de `uptime_daily`). Un graphique « 1 an » coûte donc ~365 lignes.

Les taux affichés dans la liste suivent la même logique : 24 h calculé sur le
brut (exact à la seconde), 7 j / 30 j sur l'agrégat journalier — donc en jours
UTC pleins, la convention usuelle, et toujours disponible même avec une
rétention courte.

## Incidents et notifications

Une panne est matérialisée : incident ouvert au franchissement du seuil, fermé
à la première sonde réussie. Il y a **au plus un incident ouvert par service**,
et c'est ce qui rend les alertes exactement-une-fois — une alerte appartient à
un incident, pas à une sonde.

- **Hors ligne** → mail/webhook avec l'heure de bascule et l'erreur ; l'incident
  est marqué `notified`.
- **Retour en ligne** → mail/webhook avec la durée de la panne et sa cause
  initiale, **seulement si** le « down » avait bien été notifié (sinon on
  enverrait un « c'est revenu » sans contexte).

Canaux — **une liste de destinations de l'espace, et une route qui les
désigne** (migration `087`). Voir [NOTIFICATIONS.md](./NOTIFICATIONS.md), qui
porte le modèle complet ; ce qui compte ici :

- un service peut avoir **ses propres canaux** ; sans réglage propre il suit
  ceux d'Uptime. C'est ce qui permet d'envoyer les alertes de deux services à
  deux équipes différentes, ce que les deux canaux binaires d'avant
  interdisaient ;
- **e-mail** — destinataire libre, vide = l'adresse du compte expéditeur, qui
  doit être un compte Mail « open » de l'espace ;
- **webhook** — POST JSON `{ content, text, event, service, url, at }`, où
  `event` vaut `down`, `recovered` ou `test`. Le message lisible est porté
  **deux fois**, et c'est voulu : Discord rejette tout corps sans `content` /
  `embeds` / `file` (400, « Cannot send an empty message ») et Slack lit `text`.
  Chacun ignore les clés qu'il ne connaît pas, donc un seul corps convient à
  Slack et à un point d'entrée maison. Le texte est tronqué à 1900 caractères,
  sous la limite stricte de 2000 de Discord ;
- **discord** — un type de canal à part entière depuis la `087` : il reçoit
  l'embed de `Services/notices/uptime.ts` au lieu du texte. Ce n'est plus deviné
  d'après l'URL, mais **déclaré** — le reniflage décidait à la place de
  l'utilisateur, et interdisait d'envoyer du texte brut à une URL Discord.

Le bouton « Tester » agit **par canal**, sur la ligne telle qu'elle est
enregistrée : l'ancien détour « enregistrer d'abord, sinon le test porte sur la
configuration précédente » disparaît avec l'entité.

L'écran de réglage est `Components/FeatureSettings/`, **partagé par les cinq
émetteurs et par leurs éléments**. Il remplace `Components/NotificationsDialog`,
lui-même né de la fusion de cinq copies dont l'une avait perdu au passage
l'avertissement « aucun compte expéditeur valide » — un écran laissait donc
croire à un canal actif là où l'autre prévenait.

Chaque bascule est aussi journalisée dans les logs d'audit (`uptime.down`,
`uptime.recovered`), donc consultable dans la feature Logs.

## Les deux graphiques

Le panneau de détail superpose deux lectures de la **même** fenêtre, sur le même
axe des x (`rangeWindow()` dans `Features/Uptime/format.ts`) :

- la **bande d'état** (`StatusBars`) — un nombre *fixe* de créneaux découpant la
  période choisie, vert / jaune / rouge / gris (aucune mesure). Une barre
  représente une tranche de temps, pas un échantillon : la bande a donc la même
  allure avec dix mesures ou cent mille, et un service ajouté il y a dix minutes
  affiche bien 24 h de gris derrière ses premiers points ;
- la **courbe de latence** (`UptimeChart`), avec les créneaux en échec ombrés
  derrière elle.

L'axe est la **durée sélectionnée**, jamais l'étendue des données : les deux
blocs s'alignent colonne par colonne, et un trou de surveillance se voit comme
un trou. Le seuil « lent » est relatif à la médiane du service (2×, plancher
150 ms) — un endpoint à 20 ms et un à 400 ms sont tous deux normaux.

La bande d'état sert trois endroits, en deux formes. `full` — sous un titre, avec
sa légende — dans le détail d'un service et dans l'onglet Déploiement d'un projet,
où les trois pourcentages se posent en face de la légende (`trailing`). `inline` —
plus basse, sans légende — dans chaque ligne de la liste : répétée vingt fois, une
légende pèserait plus que les barres, et la **bulle de survol** dit déjà ce
qu'elle dirait. Cette bulle remplace l'attribut `title` : l'infobulle native se
fait attendre une seconde et ne désigne jamais *quelle* barre elle décrit, ce qui
est précisément la question sur des tranches de trois pixels.

## Les trois étages du panneau

`liste des services` → `détail d'un service` → `journal des mesures`, chacun
remplaçant le précédent avec un bouton retour (le même schéma que la liste vers
le détail).

**La liste se lit, elle ne pilote pas.** Chaque ligne porte le nom, l'état, la
bande des dernières 24 h, les trois pourcentages et « Modifier ». Rien d'autre :
« tester maintenant » et « mettre en pause » y étaient deux boutons par ligne pour
des gestes rares, et vivent là où l'on se rend pour les faire — la fiche du
service porte « Tester », son formulaire porte la pause. Toute la ligne mène à la
fiche, barres comprises : repérer un creux rouge et vouloir l'ouvrir est le même
geste.

Le journal complet a son propre étage parce qu'un an de sondes fait des dizaines
de milliers de lignes : en ligne dans le détail, il enterrait les graphiques.
Le détail n'en montre donc que les **8 dernières** et renvoie à l'étage du
dessous, qui offre des filtres (période, échecs seulement), des agrégats
(`uptime.checkStats`, calculés sur toute la sélection et pas sur la page
chargée) et une liste qui défile **dans sa propre boîte** — le panneau autour ne
s'allonge jamais.

`uptime.checks` et `uptime.checkStats` partagent le même schéma de filtre, pour
qu'une page et ses agrégats décrivent toujours exactement la même sélection. Les
agrégats sont une commande à part et non un champ de sortie : ils balayent toute
la plage filtrée, et l'aperçu du détail n'a pas à payer ce coût.

## Rafraîchissement sans à-coup

Les blocs se re-interrogent à chaque sonde. Plutôt que de remplacer leur contenu
par un « Chargement… » — ce qui faisait s'effondrer puis rebondir la mise en page
— chacun est enveloppé dans `Pane` : le dernier contenu connu reste monté à sa
taille exacte, atténué, avec un spinner centré par-dessus. Les graphiques, les
incidents et le journal ont chacun leur propre état de chargement et se mettent
donc à jour indépendamment.

## Ordre d'affichage

L'ordre est **entièrement défini par l'utilisateur**, par glisser-déposer, comme
pour les notes. Rien ne repositionne un service automatiquement : seuls
`uptime.reorder` et l'ajout d'un service (qui prend le rang suivant, donc la fin
de la liste) touchent à `sort_order`.

Ça remplace le tri automatique par urgence (pannes en tête) des premières
versions : les deux ne peuvent pas coexister, et un ordre qui se réarrange tout
seul sous le curseur n'est pas un ordre.

Comme pour les notes, la barre d'insertion (`ServiceList`) est **pilotée par le
DOM, jamais par un état React** : elle se place au milieu réel du créneau,
mesuré sur les deux lignes qui le bordent — centrée par construction, sans
correction. Le rafraîchissement périodique est suspendu pendant un drag, sinon
la liste se réordonnerait sous le curseur.

**Contrairement aux notes, le glisser-déposer n'utilise pas l'API HTML5
`draggable`** (`features/notes/src/client/NoteGrid`) mais les **Pointer Events**
(`pointerdown`/`pointermove`/`pointerup` sur `window`, avec un seuil de 6 px
avant qu'une pression ne devienne un drag plutôt qu'un clic). L'API native
confie la géométrie du geste au navigateur, et sur Chromium/Linux une session
interrompue peut laisser toute la page croire qu'un drag est encore en cours :
le curseur reste en mode « attraper », plus aucun clic ne répond nulle part
(pas même le menu contextuel natif), jusqu'à ce que quelque chose d'extérieur à
la page (Echap, alt-tab) débloque le navigateur. C'est une panne de plateforme,
pas un bug atteignable depuis le code de l'app — impossible à corriger en
soignant `dragend`, seulement en ne confiant jamais le geste au navigateur.
L'implémentation maison garde 100 % de son état dans des refs du composant,
jamais dans la machine à états DnD du navigateur, et gagne le support tactile
au passage. Une pression Echap pendant un drag l'annule aussi, par sécurité.

## Commandes

`uptime.list` · `uptime.count` · `uptime.add` · `uptime.update` ·
`uptime.setEnabled` · `uptime.remove` · `uptime.reorder` · `uptime.checkNow` ·
`uptime.history` ·
`uptime.checks` · `uptime.checkStats` · `uptime.incidents` ·
`uptime.getSettings` · `uptime.setSettings` · `uptime.testNotification`

Aucune n'est verrouillée par le chiffrement par mot de passe : la feature s'ouvre
et se lit sans prompt.
