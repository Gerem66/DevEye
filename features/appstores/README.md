# Stores : les chiffres des apps sur l'App Store et Google Play

Stores relève, pour chaque app qu'un espace suit, ce qu'Apple et Google en
savent : les téléchargements jour par jour, les notes, les avis, les revenus,
l'état des versions et la stabilité chez Google. On y répond aussi
aux avis. C'est le voisin d'[Audience](../audience/README.md), qui mesure ce
qu'une app envoie elle-même, et de [Projets](../projects/README.md), qui relie
des apps dans son onglet Stores.

Documents voisins : [Docs/SOURCES.md](../../Docs/SOURCES.md),
[Docs/SHARING.md](../../Docs/SHARING.md),
[Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md) (§ Stores),
[Docs/QUOTAS.md](../../Docs/QUOTAS.md),
[Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md).

---

## 1. Le modèle

### 1.1 Une app, une fiche par store

Une **app** est un élément de l'espace. Elle porte au plus une **fiche** par
store (`ft_appstores_listings`) : sa version App Store et sa version Google
Play, chacune avec la source qui la lit. Une app sans fiche est admise, le temps
de sa sortie ; sa page invite alors à relier un store.

L'identité d'une fiche au store (l'identifiant numérique d'Apple, le nom de
paquet Android) ne change pas : relier une autre app du store demande de retirer
la fiche, et son historique avec. Une même app du store ne se suit qu'une fois
par espace : `external_ref`, un condensé à clé de `store:identifiant` lié à
l'espace (`keys.ref`), porte une clé unique avec lui. La même app suivie dans
un autre espace y a un condensé sans rapport : une copie arrive avec celui de
sa destination, un déplacement le recalcule. Un avis se reconnaît de même,
parmi ceux de son app.

### 1.2 Les sources : les clés de l'utilisateur

Rien ne se configure au niveau de l'instance chez Apple ni chez Google. Chaque
espace relie ses propres comptes, dans Réglages, onglet Sources
([Docs/SOURCES.md](../../Docs/SOURCES.md)) :

| Store       | Ce que l'utilisateur colle                                                            |
| ----------- | ------------------------------------------------------------------------------------- |
| App Store   | une clé d'API d'équipe : Issuer ID, Key ID, fichier `.p8`, numéro de fournisseur      |
| Google Play | le JSON d'un compte de service invité dans la Play Console, et le bucket des rapports |

Une source est **éprouvée avant d'être enregistrée** : une clé que le store
refuse net, ou qui n'ouvre rien, lève `validation`. Ce qu'elle sait lire est
ensuite sondé capacité par capacité (`apps`, `downloads`, `ratings`, `reviews`,
`revenue`, `versions`, `vitals`) et rangé en clair dans `capabilities`. Les
rôles d'Apple sont mal documentés : Admin semble le seul rôle qui couvre ventes,
avis et réponses, et une clé moins puissante marche avec ce qu'elle permet. Un
bloc que la clé ne lit pas le dit (« La clé … ne lit pas les avis »), au lieu
d'afficher des zéros. Répondre aux avis ne se sonde pas sans écrire : la
capacité se vérifie à la première réponse.

### 1.3 Toujours à l'étage ouvert

La synchronisation tourne **sans session**, toutes les demi-heures. Tout ce que
le module chiffre l'est donc à l'étage ouvert, clés privées comprises
([Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md), § Stores). Ce qui
reste en clair est ce qu'on agrège (téléchargements, notes, taux, revenus par
jour et par devise, note de chaque avis) et ce qui pilote la synchronisation.
Conséquence : **un projet confidentiel ne relie pas d'app**, et passer un projet
en confidentiel délie les siennes.

### 1.4 Les droits

- **Lecture** : les chiffres, les notes et les avis.
- **Écriture** : suivre une app, relier un compte de store, synchroniser,
  répondre aux avis. Répondre est un geste, donc sous l'écriture, sans droit à
  lui ([Docs/PERMISSIONS.md](../../Docs/PERMISSIONS.md) §2).
- **Revenus** (`revenue`, `extraPermissions`) : une ressource, comme les retours
  d'Audience. Sans ce droit, la section Revenus est fermée. Aucun montant ne
  sort ailleurs : ni `appstores.stats`, ni la tuile de Projets, ni les avis
  envoyés. La surcharge par app s'applique (`access: { extras: ['revenue'],
item: 'appId' }`).

Une app projetée depuis un autre espace se lit ; ses réglages, ses réponses et
sa synchronisation restent chez elle, où vit sa source.

---

## 2. À l'usage

| Vue                    | Contenu                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accueil**            | une rangée par app : puces de store (logo, puis état), téléchargements sur sept jours et leur écart, notes, « N projets »                                                    |
| **Vue d'ensemble**     | dès deux apps, au-dessus de la liste, un récapitulatif sur 30 jours (chiffres et courbe) ; un clic ouvre la vue entière, une page comme la fiche d'une app (voir ci-dessous) |
| **Fiche, Aperçu**      | bandeau (téléchargements, notes, avis reçus, taux de plantage) avec l'écart, courbe au choix, pays en liste ou sur une carte, versions des deux stores                       |
| **Fiche, Avis**        | filtres, répartition des avis reçus sur la période, cartes d'avis et leur réponse, dialogue de réponse                                                                       |
| **Fiche, Revenus**     | par store et par devise, avec le droit Revenus                                                                                                                               |
| **Fiche, Stabilité**   | taux de plantage et de blocage perçus, avec les seuils de Google, pour une app sur Google Play                                                                               |
| **Réglages, Sources**  | les comptes de store, leurs capacités, leur état ; ajout pas à pas dans un dialogue empilé                                                                                   |
| **Réglages d'une app** | onglet Général : nom, suppression ; onglet Stores : fiches de store et leur source, pays de la note Apple, cadence de synchronisation, relecture de l'année                  |
| **Onglet d'un projet** | les apps reliées, en version compacte de l'Aperçu, sans montant                                                                                                              |

L'icône de l'app, celle de l'App Store d'abord, ouvre sa rangée et son en-tête ;
un carré neutre la remplace avant la sortie. Le navigateur la charge depuis les
serveurs d'images d'Apple ou de Google, sans référent. Une fiche qui ne l'a
jamais cherchée la lit au passage suivant, sans attendre la cadence de la note.

Chaque fiche de store a sa puce, à l'accueil comme dans l'en-tête de la fiche :
son logo, puis son propre état. En temps normal, sa dernière version et l'état
de celle-ci ; sinon, dans cet ordre, « Sans compte », un échec en deux mots
(« Sans réponse », « Clé refusée »…), « Synchronisation… » pendant un rattrapage
ou une nouvelle tentative, et « Pas relevée depuis 5 h » quand le service ne
passe plus. Le survol donne la phrase entière, jusqu'où vont les données et
quand la fiche a été relevée. Pour qui écrit sur l'app chez elle, une puce en
échec est un bouton : un clic relance la synchronisation (`appstores.syncNow`).

La vue d'ensemble (`appstores.overview`, `overview.ts`) ne cumule que ce qui
s'additionne : téléchargements (total, courbe par store, part de chaque app),
pays, avis reçus, revenus par store et par devise. Une note ou un taux de
plantage moyen de plusieurs apps ne dirait rien : la note reste par app, et la
stabilité devient la liste des apps au-dessus d'un seuil de Google. Les avis
sans réponse de la période s'y lisent les plus mal notés d'abord, et se
répondent sur place. Les revenus ne comptent que les apps où le rôle tient le
droit Revenus (`items.canExtra`), et le disent quand il en manque. La période
finit au dernier jour commun aux fiches, sauf celles dont le dernier jour
traîne de plus de trois jours derrière celui des autres fiches de leur store :
une clé cassée ne fige pas la vue, et la fiche laissée de côté est nommée.

Les décisions d'écran qui méritent d'être connues :

- **La fenêtre se termine au dernier jour complet**, commun aux fiches de l'app
  (`dataUntil`), et non à aujourd'hui : les stores publient avec un ou deux
  jours de retard, et les derniers jours ressembleraient sinon à une chute.
  L'écran dit « Données jusqu'au … ».
- **L'écart à la période précédente** est la moitié de l'information, comme dans
  Audience, et il est **masqué** quand cette période n'est pas entièrement
  relevée (`previousCovered`) : le rattrapage ne remonte qu'à un an.
- **La répartition des étoiles est celle des avis reçus** sur la période.
  Aucun store n'expose la répartition de toutes les notes.
- **Une courbe de téléchargements se lit au choix** : par store, en total, en
  total face à la période d'avant (en pointillés), en moyenne sur 7 jours, ou
  par app sur la vue d'ensemble (les cinq premières, puis les autres, chacune
  marquée de son icône à gauche du départ de sa courbe quand la place le
  permet). Sur un seul store, « par store » et « total » ne font qu'un bouton, à
  son nom. Ce choix, la période et le store se retiennent dans le navigateur
  (`prefs.ts`), en deux jeux : l'un commun à toutes les fiches d'apps, l'autre
  à la vue d'ensemble, que son récapitulatif sur l'accueil suit sans le régler.
- **Les revenus ne se somment jamais** entre stores ni entre devises : Apple
  rend des produits nets, Google des ventes estimées avant sa commission.
- Fenêtres de 7, 30, 90 et 365 jours, une seule pour toute la fiche, à droite
  des onglets ; la dernière se lit par semaines. À côté, le choix du store
  (« Tous », « App Store », « Google Play ») vaut pour l'aperçu, les avis et les
  revenus ; un seul store choisi, la fenêtre va jusqu'à son propre dernier jour.

---

## 3. Comment ça marche

### 3.1 Ce que chaque store donne

| Donnée          | Apple                                                                                            | Google                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Liste des apps  | `GET /v1/apps`                                                                                   | Reporting API `apps:search`, à défaut les noms des fichiers d'installations du bucket |
| Téléchargements | rapport `salesReports` DAILY SALES SUMMARY, version `1_0`, TSV gzippé, un par compte et par jour | CSV `stats/installs/installs_<paquet>_<AAAAMM>_overview.csv`, en UTF-16               |
| Pays            | le même rapport, colonne `Country Code` : le pays de l'App Store                                 | CSV `stats/installs/installs_<paquet>_<AAAAMM>_country.csv`, colonne `Country`        |
| Note            | API publique iTunes Lookup, sans clé, dans le pays de référence de l'app                         | CSV `stats/ratings/…`, moyenne totale                                                 |
| Avis            | `customerReviews`, tout l'historique                                                             | `reviews.list` : les sept derniers jours seulement                                    |
| Réponse         | `customerReviewResponses`, 5 970 caractères ; la remplacer = supprimer puis recréer              | `reviews/{id}:reply`, 350 caractères                                                  |
| Revenus         | le même rapport : unités × produit net, par devise                                               | `sales/salesreport_<AAAAMM>.zip`, ventes estimées avant commission, hors taxes        |
| Versions        | `appStoreVersions`, champ `appVersionState`                                                      | `tracks/production/releases` : la piste de production, en lecture seule, sans date    |
| Stabilité       | aucun                                                                                            | Reporting API `crashRateMetricSet` et `anrRateMetricSet`, taux perçus                 |
| Icône           | la même recherche iTunes que la note, `artworkUrl100`                                            | la page publique de l'app, balise `og:image`, sans clé, une fois par jour             |

### 3.2 La synchronisation

`service.ts` bat toutes les minutes (`deps.createTicker`), et une fois au
démarrage. Trois cadences par fiche :

- les chiffres du jour toutes les six heures, avec un rattrapage borné à un an
  au premier branchement (`history_from` en garde le premier jour) ;
- les avis et les versions toutes les trente minutes ;
- la note Apple une fois par jour.

Les fiches dues passent de la plus ancienne synchronisation à la plus récente,
par lots, en excluant celles que l'offre tient en pause. **Un rapport Apple du
jour sert toutes les apps du compte** : la passe des chiffres se fait donc par
source, puis répartit les lignes entre les apps. Une seule passe à la fois par
source, et chaque passe a son budget (trente rapports ou objets, dix pages
d'avis) : un rattrapage d'un an s'étale sur plusieurs battements.

Quand un store répond 429, la source attend : soixante secondes qui doublent,
quinze minutes au plus, ou ce que dit `Retry-After`. C'est un horodatage « pas
avant », jamais une attente dans le battement. À l'arrêt, `stop()` coupe les
requêtes en vol, puis attend le battement et chaque passe par source.

Rien ne se synchronise à la main en temps normal : les stores ne publient qu'une
fois par jour, et une app ajoutée ou reliée réveille le service, qui la passe en
premier. Seule exception, la nouvelle tentative d'une fiche en échec
(`appstores.syncNow`) : l'app passe tout de suite, cadences ignorées et repli de
ses sources levé, sans rien relire de l'année. Le délai du repli reste, qu'un
nouvel échec doublera. Une relecture demandée pendant une tentative pas finie est
refusée en conflit : elle ne pourrait plus la rembobiner.

« Relire l'historique », dans l'onglet Stores de l'app (`appstores.backfill`),
relance le rattrapage d'un an sans rien effacer : Apple relit ses rapports du
dernier jour relevé vers le passé, Google ses mois jusqu'au même mois de l'an
dernier, `etag` oubliés. La première passe ouvre l'opération, les battements
suivants finissent le rattrapage ; `history_from` ne recule jamais, si bien que
les chiffres déjà là restent affichés pendant la relecture.

### 3.3 Apple

Le jeton est un JWT ES256 signé par `node:crypto` avec le `.p8`, valable dix-neuf
minutes, gardé en cache. Le rapport de ventes compte comme téléchargements les
seuls premiers téléchargements (types de produit 1, 1F, 1T, F1, 1E, 1EP, 1EU),
hors mises à jour et retéléchargements. Les achats intégrés se rattachent à leur
app par le SKU parent. Un 404 « aucune vente » vaut zéro pour un jour vieux de
plus de deux jours, heure du Pacifique, et « pas encore publié » pour un jour
plus récent, qu'on retente.

### 3.4 Google

Le JSON du compte de service signe un JWT RS256, échangé auprès de
`https://oauth2.googleapis.com/token`. **Le `token_uri` du fichier est ignoré** :
sans quoi l'utilisateur choisirait où le serveur envoie une assertion signée.
Les CSV se décodent par `TextDecoder` (UTF-16 avec BOM) et se lisent par le nom
de leurs colonnes, jamais par leur position. Un objet du bucket dont l'`etag`
n'a pas changé n'est pas relu. Le zip des ventes passe par un lecteur minimal
(`parse/unzip.ts`, `inflateRaw` asynchrone, taille de sortie bornée), sans
dépendance.

### 3.5 Les pannes

Trois refus de suite (401, ou 403 sans aucun appel réussi) marquent la source en
échec : `failing_since`, et une phrase écrite par le module, jamais recopiée du
store. **Un seul avis part, par source**, vers l'union des canaux de ses apps
(`notify.send(alert, { itemIds })`), puis un avis « rétablie » si la perte avait
été annoncée. Un 403 sur une seule app, quand le reste passe, ne note que son
`sync_error`. Une panne que l'utilisateur explique (sa clé, ses permissions, le
store qui ne répond pas) passe par `logFailure`, en `info` avec `cause: 'user'`.

`sync_error` porte la phrase, et l'état chiffré de la fiche sa nature (`failure` :
clé refusée, accès refusé, introuvable, appels limités, sans réponse, autre), que
la puce dit en deux mots. Un échec qui paraît, change ou se lève prévient les
écrans, même sans chiffre nouveau.

---

## 4. Le contrat avec Projets

Le serveur offre `APPSTORES_ITEMS_PROVIDER` (`exists`, `labelOf`), que Projets
lit avant de relier une app ; le client offre `APPSTORES_CLIENT_PROVIDER`
(`listApps`, `summarize`, `LinkedApp`, `AppDialog`), qui compose l'onglet Stores
d'un projet et ses tuiles. Aucun des deux ne porte de montant. La table de
liaison appartient à Projets (`ft_projects_appstores_links`). La liste des apps
montre combien de projets relient chacune, et la fiche les nomme.

---

## 5. Partage, déplacement, copie, export

- **Partage** (`shareTier: 'open'`) : une app se projette dans d'autres espaces,
  qui la lisent ; elle se règle chez elle.
- **Déplacement** : l'app, ses fiches, ses chiffres (pays compris), ses revenus
  et ses avis la suivent. Sa source reste dans l'espace quitté (`source_id` à NULL), et le
  déplacement est bloqué si l'espace d'arrivée suit déjà la même app du store.
- **Copie** : seulement l'app et ses fiches. Les chiffres et les revenus restent
  hors de l'arbre, comme ceux d'Audience : une copie passe par qui sait lire
  l'app, sans exiger le droit Revenus. Les avis sont un cache, relu chez les
  stores (Apple remonte un an, Google sept jours). `copy.admit` vérifie le quota
  et refuse une app du store déjà suivie à l'arrivée.
- **Export du compte** : les sources sans leur secret, les apps, leurs fiches et
  leurs avis, qui portent les réponses du compte. Les chiffres et les revenus,
  un historique importé des stores, en sont écartés avec leur raison.

---

## 6. Carte du code

| Fichier                                                                                                       | Rôle                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/manifest.ts`, `src/contracts/*`                                                                          | le manifest, les schémas et les commandes                                                      |
| `src/server/index.ts`                                                                                         | l'entrée serveur : handlers, service, quotas, éléments, export, e2e                            |
| `src/server/sources.ts`                                                                                       | les comptes de store : ajout éprouvé, test, retrait                                            |
| `src/server/apps.ts`                                                                                          | les apps : liste, fiche, ajout, réglages, suppression, synchronisation                         |
| `src/server/stats.ts`, `src/server/days.ts`                                                                   | les fenêtres, l'écart, les revenus, l'arithmétique des jours                                   |
| `src/server/overview.ts`                                                                                      | la vue d'ensemble de toutes les apps                                                           |
| `src/server/reviews.ts`                                                                                       | les avis et la réponse                                                                         |
| `src/server/service.ts`, `src/server/notice.ts`                                                               | la synchronisation de fond, et les avis qu'elle envoie                                         |
| `src/server/stores/*`                                                                                         | les clients d'Apple et de Google, les jetons                                                   |
| `src/server/parse/*`                                                                                          | TSV, CSV (UTF-16 compris), zip                                                                 |
| `src/server/copy.ts`, `move.ts`, `accountExport.ts`                                                           | partage, déplacement, copie, export                                                            |
| `src/server/e2e.ts`                                                                                           | les parcours de la page Tests et débogage                                                      |
| `src/client/AppStores.tsx`, `AppList.tsx`, `OverviewRecap.tsx`, `StoresOverview.tsx`                          | l'accueil de la fonctionnalité, son récapitulatif et la vue d'ensemble                         |
| `src/client/AppDetail.tsx` et ses onglets                                                                     | la fiche : `Overview`, `Reviews`, `Revenue`, `Stability`                                       |
| `src/client/StoreChips.tsx`, `AppIcon.tsx`                                                                    | les puces de store, leur état et la nouvelle tentative ; l'icône de l'app                      |
| `src/client/SourcesPanel.tsx`, `SourceDialog.tsx`                                                             | l'onglet Sources                                                                               |
| `src/client/AppGeneralPanel.tsx`, `ListingsPanel.tsx`, `appSettings.ts`, `AppDialog.tsx`, `ListingPicker.tsx` | l'ajout, et les onglets Général et Stores de l'app                                             |
| `src/client/Stats/*`                                                                                          | bandeau, courbe en SVG écrit à la main, répartition des étoiles, pays en liste et sur la carte |
| `src/client/provider.tsx`                                                                                     | le contrat client avec Projets                                                                 |

---

## 7. Les tables

| Table                    | Ce qu'elle tient                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `ft_appstores_sources`   | les comptes de store ; `secret_enc` porte la clé privée, `capabilities` ce qu'elle a su lire      |
| `ft_appstores_apps`      | les apps ; nom et pays de la note dans `content`                                                  |
| `ft_appstores_listings`  | une fiche par app et par store ; `state` est écrit par le service seul                            |
| `ft_appstores_daily`     | les chiffres d'un jour, par app et par store, en clair ; jamais purgée                            |
| `ft_appstores_countries` | les premiers téléchargements d'un jour par pays, seuls les pays non nuls ; gardés un an           |
| `ft_appstores_revenue`   | les revenus d'un jour, par devise, sur trois décimales                                            |
| `ft_appstores_reviews`   | les avis : note et dates en clair, le reste chiffré ; un an et 5 000 par app et par store au plus |

Les jours se comptent depuis 1970, en UTC. Les fiches n'ont pas de clé étrangère
vers leur source (voir § 11).

---

## 8. Configuration

Aucune variable d'environnement. Les adresses contactées sont écrites en dur :
`api.appstoreconnect.apple.com`, `itunes.apple.com`, `oauth2.googleapis.com`,
`storage.googleapis.com`, `androidpublisher.googleapis.com` et
`playdeveloperreporting.googleapis.com`. Ce sont des services que l'espace
relie avec ses propres clés : ils n'ont pas de carte dans la page Services
externes, mais figurent dans la liste « À propos » des services tiers.

---

## 9. Les quotas de l'offre

`appstores.apps` est un stock (« apps suivies ») : 1 en Gratuite, 10 en Pro
(`DevEye-Billing/src/server/plans.ts`). Au-delà, après une baisse d'offre, les
apps les plus récentes sont mises en pause : leur synchronisation s'arrête, et
la relecture de l'année et la réponse aux avis sont refusées (`assertActive`). L'écran
le dit (`PlanPausedBadge`, `PlanPausedNotice`).

---

## 10. Notifications

- **Nouveaux avis** : un avis par app et par passage, qui compte les nouveaux,
  nomme la note la plus basse et cite les premiers. Le premier passage d'une
  fiche n'envoie rien pour ce qu'il rattrape.
- **Versions Apple** : à chaque changement utile (soumise, en revue, acceptée,
  rejetée, en production).
- **Stabilité Google** : quand la moyenne sur 28 jours du taux perçu, pondérée
  par utilisateurs, franchit le seuil de Google (1,09 % pour les plantages,
  0,47 % pour les blocages), puis quand elle redescend.
- **Source** : refusée, puis rétablie, un avis par source.

Aucun avis ne porte de montant.

---

## 11. Pièges, et pourquoi ils existent

- **Le `token_uri` d'un JSON Google est ignoré**, l'adresse du jeton est écrite
  en dur (§ 3.4).
- **Pas de clé étrangère des fiches vers leur source** : InnoDB peut revalider
  la ligne mise à NULL contre l'espace que la même cascade supprime, et la
  suppression d'un espace échoue alors. Le module remet `source_id` à NULL
  lui-même avant de retirer une source.
- **Google ne rend que sept jours d'avis** : l'historique commence au
  branchement, et une copie n'emporte pas les avis.
- **Les montants restent hors de la copie** (§ 5).
- **Un 404 d'Apple ne dit pas pourquoi** : « aucune vente » et « pas encore
  publié » se distinguent par l'âge du jour (§ 3.3).
- **Les CSV de Google sont en UTF-16** et changent de colonnes : on les lit par
  le nom des colonnes.
- **L'icône Google se lit sur la page publique de l'app** (`og:image`) : l'API
  Publisher ne la donne qu'en ouvrant une modification. Si Google change sa
  page, l'icône manque, et rien d'autre ; seule une adresse de
  `play-lh.googleusercontent.com` est retenue, comme `mzstatic.com` chez Apple.

---

## 12. Limites

- Pas de stabilité chez Apple. Les versions de Google n'ont pas de date, et
  leurs changements ne préviennent pas. Google ne rend que ses versions
  actives : les cinq dernières se gardent de mémoire, à partir du branchement.
- La note Apple est celle d'un pays : Apple n'en publie pas de mondiale.
- La carte des pays (`Stats/worldShapes.ts`) vient de Natural Earth au 1:110 m,
  domaine public : les pays trop petits à cette échelle (Singapour, Malte…) n'y
  figurent pas, et sont nommés sous elle.
- Les revenus Google sont estimés et bruts de la commission ; aucune devise n'est
  convertie.
- Les rapports d'analyse d'Apple (sessions, provenance) ne sont pas lus : leur
  première demande exige une clé Admin.
- La vraie synchronisation ne se vérifie qu'avec les clés d'un vrai compte de
  store : les parcours de bout en bout n'en ont pas.

---

## 13. Tests

`npm run test:features`, sans base ni réseau (les clients des stores reçoivent un
`fetch` factice) :

- `stores/apple.test.ts` : le jeton ES256, le rapport de ventes (téléchargements,
  produits nets, achats intégrés rattachés), le jour sans vente contre le jour
  pas encore publié ;
- `stores/google.test.ts` : le jeton RS256, les CSV en UTF-16, le zip des
  ventes, la Reporting API, le refus d'un bucket ou d'un paquet mal formé ;
- `service.test.ts` : la sélection et les pauses, le repli par source, la source
  perdue puis rétablie, les avis groupés et le premier passage silencieux, les
  versions, les seuils de stabilité, l'arrêt ;
- `handlers.test.ts`, `copy.test.ts`, `move.test.ts`,
  `accountExport.test.ts` : aucun montant dans `stats`, la réponse retrouvée par
  l'avis, le quota, les secrets jamais rendus, les revenus jamais copiés.

Les parcours de la page Tests et débogage (`e2e.ts`) : `apps` (une app sans
store, renommée puis supprimée), `projects` (la liaison depuis le projet, puis
depuis les réglages de l'app, et sa disparition avec l'app), `sources` (le refus
d'un `.p8` mal formé et d'un JSON incomplet).
