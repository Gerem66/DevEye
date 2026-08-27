# Le SDK des modules de features

Écrite le 21 août 2026, à la livraison du chantier. Doc de **mainteneur** : le
tiers qui développe un module lit la doc anglaise du
[template](https://github.com/Gerem66/DevEye-Feature-Template), celle-ci dit
comment l'app tient sa part du contrat.

## Le modèle

Un module est un **package compilé** : il vit dans son repo (créé depuis le
template), l'app le déclare dans `features.config.json`, et
`npm run gen:features` écrit la glue (commitée, le serveur n'ayant pas de
build). Rien ne se charge à chaud ; installer = dépendance npm + une entrée de
config + une génération. Les features natives rapatriées vivent dans
`features/*` (workspaces npm) et passent par le même chemin : Météo est la
première, et la preuve que le contrat suffit.

## Les trois étages

1. **`@deveye/types/sdk`** (publié) : le contrat. Ids `x-<slug>` pour les
   modules externes, l'id natif pour une native rapatriée, `FeatureManifest`
   + `validateManifest`, le contexte serveur (`SdkFeatureContext`,
   `FeatureStore`, façade), les contrats client (`FeatureClient`), les deux
   harnais de test (`createTestContext`, `createTestServiceDeps`). **C'est la
   surface publique** : elle se versionne, elle ne casse plus.
2. **Le serveur** : `src/features/_sdk/` adapte. `register.ts` projette les
   définitions SDK en `FeatureDefinition` natives (accès de LA feature +
   extras en enveloppe), le dispatcheur ne sait pas qu'un module existe.
   `context.ts` est la frontière exacte de ce qu'un handler voit ; `store.ts`
   porte la règle de chiffrement (mode figé sur la ligne, 'private'
   inexprimable côté services) ; `facade.ts` garde chaque appel aux natives
   derrière `nativeCapabilities`. Migrations de modules : deuxième passe du
   runner, noms `<id>/<fichier>`, tables `ft_<slug>_` vérifiées par le
   générateur.
3. **Le client** : `client/src/sdk/index.ts` est le barrel servi sous l'alias
   `deveye-sdk-client` : LE seul import légal d'un module. `sdk/modules.ts`
   enregistre descripteurs et ressources au chargement ; catalogue, coquille
   de réglages, RoleDialog et goToHome lisent le manifest.

## La frontière stable / interne

**Un seul package (`@deveye/types`), décision du 24 août 2026** : la coupe
`@deveye/sdk` séparé est la bonne cible à terme (audience et rythme de
version différents), mais pas pendant la vague de migration — presque chaque
native élargit la surface, et deux packages doubleraient publications,
correspondances de versions et miroirs pour un gain partiel (le SDK
dépendrait des types de toute façon). Critère de bascule : vague terminée et
surface stabilisée, ou premier vrai module tiers. La coupe sera mécanique :
`src/sdk/` est déjà autonome.

Est stable : tout ce qu'exportent `@deveye/types/sdk*` et le barrel
`deveye-sdk-client`. Tout le reste est interne et peut bouger. Élargir la
surface = l'ajouter à l'un de ces deux endroits, mettre à jour le portrait
typé du barrel — publié DANS @deveye/types (`src/sdk/client-ambient.d.ts`,
que le template tire par une entrée `include` de son tsconfig) — et la doc
REFERENCE du template.
`npm run check:sdk` (client) vérifie MÉCANIQUEMENT que le vrai barrel honore
ce portrait : une dérive casse la CI de l'app, jamais le build d'un tiers.
Jamais d'export « en douce » par un autre chemin.

Une native rapatriée a un privilège de plus, commenté à chaque usage : elle
peut importer l'app directement (les adaptateurs de fournisseurs) là où le
barrel ne suffit pas. Un module externe, jamais.

## Les sentinelles, en trois couches

1. `validateManifest` + vérifications du générateur (ids, collisions, version
   minimale de types, préfixe SQL) : la CI du template ET `gen:features`.
2. `gen:features --check` dans le `ci` de l'app : la glue commitée ne peut pas
   dériver de la config.
3. Le boot : `registerModules` (manifest, doublons, notify sans notifies),
   puis les sentinelles historiques sur l'ensemble fusionné
   (`buildTopicIndex` : le préfixe d'un module EST son id, règle structurelle ;
   `assertAccessDeclared` : les commandes enveloppées déclarent toutes leur
   accès, aucune exemption nouvelle).

## Le SDK v2 : l'infrastructure (22 août 2026)

Le rapatriement d'une native d'infrastructure en module PRIVÉ a élargi le contrat :

- **Capacités** : `devices.read` (authorize/list/isOnline) et `agents` (la
  façade de la flotte : les neuf requêtes sync sortantes aux noms du hub, le
  fan-out navigateurs, `ctx.transport` pour le socket appelant), cette
  dernière réservée aux modules à id natif.
- **Hooks agent** (`FeatureService.agentHooks`) : les événements entrants
  (`onAgentConnect`, `onSync*`), agrégés par `moduleAgentHooks()` avec un
  no-op par défaut ; la couche `agent/ws.ts` ne connaît plus aucun module.
- **Providers** (`FeatureService.providers` + `moduleProvider(clé)`) :
  l'inversion pour du code public qui a besoin des données d'un module :
  l'appelant cherche le contrat à l'exécution et dégrade proprement quand le
  module est absent (source masquée, run en échec propre).
- **Clés serveur** (`deps.keys.sealBytes/openBytes`) : wrapper du matériel de
  clé au format natif exact (la BMK existante se relit telle quelle).
- **Service enrichi** : start async, `deps.audit` (source système, alias de
  catégorie côté app), démarrage awaité DANS buildApp avant les sockets.
- **Manifest** : `alsoInvalidatedBy` (couplage de données entre sujets) et
  `commandPrefix` (un id natif dont la casse historique des commandes
  diffère de l'id).
- **Mini-widget de topbar** : `manifest.topbarWidget` + `TopbarWidget` dans
  l'entrée client. Rendu SANS prop, c'est le contrat de sécurité : l'hôte ne
  lui tend rien, tout ce qu'il affiche passe par les commandes de SA feature
  (autorisées côté serveur), et il n'est proposé et monté que pour les membres
  dont le rôle accorde la feature (`canFeature`). Liberté dans la boîte, rien
  dehors.
- **Installation privée** : `features.local.json` (gitignorée, entrées par
  chemin) + trois fichiers locaux toujours présents, réparés par
  `gen:features` (`--ensure-local` en prestart et en tête de ci ; `--check`
  vérifie les committés, répare les locaux). La CI publique ne voit jamais un
  module privé. Import de la glue locale en RELATIF sans extension.

## La migration des natives (22 août 2026)

**OSINT** est la deuxième native rapatriée (`features/osint`), sur le patron
exact de Météo : descripteur étalé dans le manifest, tables historiques en
allowlist `deveye-feature.json` (075, jamais déplacées). Chiffrement :
`ctx.cipher('private')` pour l'historique (l'ex-`ctx.secure`), `ctx.cipher()`
pour les clés de fournisseurs (l'étage ouvert, comme pour Météo).

**La norme d'isolation (24 août 2026)** : une feature migrée est TOUT ENTIÈRE
dans son répertoire. Ses contrats zod et son domaine vivent dans
`src/contracts/` (le patron du template), ses services aussi (les sondes
OSINT, l'adaptateur météo — seul reste à l'app ce qui est réellement partagé,
comme le garde SSRF de `Services/netFetch`, importé avec le privilège de
native commenté). `@deveye/types` ne garde que l'IDENTITÉ (l'id dans les
enums, le descripteur du registre — ce que les écrans des autres doivent
savoir sans ouvrir la feature) et les points de couplage déclarés (providers,
protocole agent). Ses commandes s'enregistrent au runtime par le manifest,
comme celles de CloudSync : le registre natif des commandes ne les porte
plus.

Sa migration a élargi la surface stable, pour toutes les features :

- **`featureApi().send(name, input, { timeoutMs })`** : le délai d'attente
  d'une commande qui interroge un tiers lent (une sonde OSINT à 30 s).
- **Le chiffrement par mot de passe côté client** : `useSecrecy()`,
  `ensureSecrecyUnlocked()`, `withSecrecy(run)` (le patron « réessaie une fois
  après l'invite », promu de ses cinq copies locales dans
  `stores/secrecy.ts` ; les copies restantes — Notes, Password, Projects,
  Mail — se résorberont à leur migration).
- **`humanizeError`** traduit aussi `locked` et `timeout`.

Chaque élargissement est reflété dans le portrait publié
(`@deveye/types/src/sdk/client-ambient.d.ts`, vérifié par `check:sdk`) et la
doc du template (REFERENCE + 04-storage-and-encryption).

**Finances** est la troisième native rapatriée (`features/finance`, 27 août
2026), sur le même patron : descripteur étalé, six tables historiques en
allowlist (084), `ctx.cipher()` seul (tout vit à l'étage ouvert, l'ex
`ctx.secure.open`), pas de service de fond (le rattrapage des échéances reste
une matérialisation paresseuse en tête des lectures). Ce que sa migration a
réglé : la dette de la coquille de réglages (`SettingsDialog` +
`CategoriesDialog` derrière un engrenage maison) est devenue deux panneaux
déclarés par le manifest, `general` et l'onglet personnalisé `categories` (le
premier `CustomTabRef` d'une native) ; les fiches d'opération et de budget ne
font plus que choisir une catégorie, et montent le bouton commun là où elles
ouvraient le dialogue (patron des sources). Rien d'autre dans l'app ne lisait
ses types : ils ont quitté `@deveye/types` sans qu'aucun provider ne soit
nécessaire.

**Le Coffre** est la quatrième native rapatriée (`features/password`, 27 août
2026), et la première à vivre tout entière à l'étage gardé :
`ctx.cipher('private')` (l'ex `ctx.secure`) pour chaque entrée, et
`ctx.secrecy.isUnlocked()` posé AVANT de lire, parce qu'une liste vide n'est
pas une liste verrouillée (le client attend `locked` pour rouvrir l'invite,
par le `withSecrecy` du barrel). Une table historique en allowlist (001,
rattachée à l'espace par la 048), pas de service, pas de réglages ; `hasItems`
au descripteur, donc `itemSegment` au manifest (l'entrée ouverte, par son id
nu). Ce que sa migration a retiré : la commande `password.unlock` et son
registre en mémoire par session (`markUnlocked` / `forgetSession`, avec son
crochet de fin de session dans `ws/handler.ts`), un mécanisme sans lecteur
(le déverrouillage passe par `secrecy.unlock`, la protection réelle est le
chiffrement), et `popup-unlock`, le dialogue orphelin de l'accueil qui
l'appelait. Ses copies locales de `withSecrecy` / `humanizeError` ont rejoint
celles du barrel, comme annoncé plus haut.

**Les Notes** sont la cinquième native rapatriée (`features/notes`, 27 août
2026), et la première à cheval sur les deux étages : `ctx.cipher('private')`
pour le corps d'une note privée, `ctx.cipher()` pour tout le reste (notes
ordinaires, noms de dossiers), le choix du cipher tenant lieu de contrôle
d'accès ; `ctx.secrecy.isUnlocked()` ne sert qu'aux écritures sur une note
privée (édition, archivage, destruction), qui n'ont pas besoin de lire le
corps mais ne doivent pas écraser ce qu'une session scellée ne voit pas, et à
masquer la liste (jamais bloquée). Deux tables historiques en allowlist (014
et 015, complétées jusqu'à la 036), pas de service, pas de réglages ;
`hasItems` au descripteur, donc `itemSegment` au manifest (la note ouverte,
par son id nu). Ce que sa migration a décidé : le **renommage franc** de ses
quatorze commandes sous le seul préfixe `notes.` (le contrat du manifest ;
`commandPrefix` ne sert qu'à une casse différente du même id), les dossiers
passant de `folder.*` à des verbes camelCase (`notes.folderAdd`...), et les
clés de ressources avec elles (`notes.count`, `notes.list`) ; le **`shareTier:
'never'` déclaré par-dessus le descripteur**, qui dit `'perItem'` (ce que le
chiffrement autorise) alors que le listage n'est pas branché sur le partage
(SHARING.md §9 : un graphe dossiers/notes, pas des lignes) et qu'un module qui
déclare autre chose s'engage à l'être, sous peine de refus au boot ; et la
**palette des notes en jetons du module** (`--note-<nom>` sur `:root` de son
`style.module.css`, avec l'encre `--note-print-*` de l'export PDF), retirée de
`Styles/theme.css` : ce sont les couleurs qu'un utilisateur choisit, une donnée
de la feature, pas le thème. Sa migration a appris au harnais de test à
sceller son cipher `'private'` sous `unlocked: false` (`decrypt` lève
`locked`, `tryDecrypt` rend null, comme le vrai) : c'est le cipher, et non une
garde, qui refuse `notes.get` sur une note privée scellée, et un test doit
pouvoir le voir.

**Uptime** est la sixième native rapatriée (`features/uptime`, 27 août
2026), et la plus riche de la vague : elle inaugure côté module le **partage
inter-espaces** (`shareTier: 'open'` étalé du descripteur, tenu par l'entrée
`items` du serveur, `ctx.sharing.scope()` dans ses listages et le codec choisi
ligne par ligne), les **restrictions par élément** (`ctx.items.restrictions()`,
`ctx.items.assert()`, `ctx.items.forget()` au ménage), le **service de fond
avec `live.changed`** (l'ex `UptimeMonitor` sur `FeatureServiceDeps` : deux
tickers, les sondes et l'élagage horaire des pings bruts sorti du balayage de
rétention d'`index.ts`, `deps.deveyeFor(ws).notify.send(alert, { itemId })`
dont le booléen marque l'incident `notified`, les variables `UPTIME_*` lues
par le module), le **widget de topbar d'une native** (rendu sans prop dans le
cadre de l'hôte, teintes du module en trois classes pour peser plus que
l'accent de l'hôte) et la **composition client inter-modules** : Projets lit
`moduleClientProvider(UPTIME_CLIENT_PROVIDER)` (bande d'état, taux,
historique, dialogue de déclaration) et le serveur
`moduleProvider(UPTIME_ITEMS_PROVIDER)` avant de relier un service, l'un et
l'autre dégradant proprement quand le module est absent. Le singleton de
l'ordonnanceur est posé par `createService` pour les handlers (patron
`setEngine` de CloudSync). Ce que sa migration a réglé : la dette de la
coquille (cadence, délai, seuil et rétention d'un service sont un panneau
Général à l'échelle de l'élément, le dialogue ne garde que l'identité), la
commande morte `uptime.testNotification` et l'avis « test » de sa mise en
page (l'essai passe par `notify.channelTest`), l'entrée native du widget de
topbar et celles de `SHARE_WIRED_FEATURES`, `ITEM_SEGMENT`, `LIST_KEYS` et
`TOPIC_KEYS`. Ce que le contrat client a demandé côté module : `Ratios` ne
lit plus qu'un `Pick` des trois taux (ce que `UptimeLinkedService` porte), et
le dialogue offert à l'hôte est un adaptateur qui recharge la fiche complète
avant d'ouvrir le vrai formulaire. Le projet serveur des modules
(`features/tsconfig.server.json`) inclut désormais les déclarations
ambiantes de l'app (`src/types`) : un import de privilège
(`@/Services/notifications`) atteint des fichiers qui en dépendent.

**Sentinelle** est la septième native rapatriée (`features/sentinel`, 27 août
2026), et la plus entremêlée à l'infrastructure : elle inaugure côté module
les **hooks agent de télémétrie** (`onReport`, `onMetricsBatch`,
`onIntegrity`, `onAuthEvents`, tendus par les handlers agent de l'app une fois
la télémétrie persistée, pour tout appareil actif ; c'est le module qui relit
sa config et décide, l'app ne garde plus rien de ses réglages), la **façade
télémétrie** (`telemetry.snapshot` remplace la lecture en dur de l'instant,
`telemetry.pinInstant` l'épinglage de la preuve), la **flotte par la façade**
(`deps.devices.find` rend un `SdkDevice` au rapport déjà analysé,
`ctx.deveye.devices.list` porte la règle « l'admin dans son espace personnel
voit la flotte »), la **façade agents** (`requestScan`, `pushConfig`) et le
**provider vers l'app** (`SENTINEL_AGENT_CONFIG_PROVIDER` : l'app recompose la
config poussée à un agent, `src/agent/config.ts`, en demandant au module sa
part ; `DEFAULT_SENTINEL_INTEGRITY_MINUTES` vit à côté, dans
`sdk/providers.ts`). Ce que sa migration a décidé : l'**option B** pour ses
réglages par appareil, les cinq colonnes `sentinel_*` de `devices` (074)
quittent la table du socle pour `ft_sentinel_device_config`, créée et
remplie par la 098 du SOCLE (ses migrations tournent avant celles des modules,
et la copie devait précéder la suppression des colonnes) puis possédée par le
module (`uninstall.sql`, hors allowlist parce qu'au préfixe) ; les dépôts du
module ne joignent plus `devices` (les noms viennent de la façade, par
requête) ; les 31 vérifications de `scripts/check-rules.ts` (`ci:rules`)
deviennent `rules.test.ts`, un test du module ; les variables `SENTINEL_*` se
lisent dans le module ; la dette de la coquille (`SentinelDialog` par appareil
derrière un second engrenage) devient l'onglet personnalisé `devices` du
manifest, un panneau listant les appareils visibles avec leur configuration
en ligne (Sentinelle n'a pas d'éléments : ses éléments sont des appareils) ;
et l'état de flotte porte désormais les cadences réglées (`integrityMinutes`,
`authEvents`), pour que le panneau parte des vraies valeurs et non des
défauts.

L'outillage de migration, à rejouer pour CHAQUE native :

- **Tests de modules** : `npm run test:features` couvre
  `features/*/src/**/*.test.ts` (harnais `@deveye/types/sdk/testing`, voir
  `features/osint/src/server/handlers.test.ts`), et le tsconfig racine inclut
  ces fichiers pour le typecheck.
- **L'IDE** : `features/tsconfig.json` est le projet CLIENT des modules
  in-repo (extends celui du client : alias `deveye-sdk-client`, JSX) ; leur
  part serveur et leurs contrats sont inclus par le tsconfig RACINE. tsserver
  remonte l'arbre jusqu'au premier tsconfig qui contient le fichier — jamais
  jusqu'à `client/`, qui n'est pas un ancêtre : sans ce fichier, le client
  d'un module tombait dans un projet inféré. Pas de `references` (elles
  exigeraient `composite`, impraticable ici). Vérifié en interrogeant
  tsserver ; `npm run typecheck:features` compile ce projet en CI.
- **Smoke E2E du chemin client** : `npm run smoke:feature -- <id> <label>`
  (serveur démarré sur le bundle construit, compte seedé). Il vérifie ce
  qu'aucune autre sentinelle ne voit : la feature au marché d'ajout, la tuile
  posée, un aller-retour de commande sur le fil, zéro exception JS.
  **Automatisé** par `npm run ci:smoke` (`scripts/smoke-all.ts`) : construit
  le client dans `.smoke/client` (hors de `client/`, que son lint ratisse),
  démarre un serveur à lui sur le port
  3999, sonde chaque module de `features.config.json` (+ l'overlay local en
  local), éteint tout. Lancé par `./ci.sh` (contrôle `deveye-smoke`, il lui
  faut la base — le tunnel en local) et par le job `smoke` du workflow GitHub
  (service MySQL neuf, migré de zéro au boot, Chrome du runner).

## La désinstallation d'un module (22 août 2026)

Le geste inverse de l'installation, conçu pour emporter TOUTES les traces :
`npm run uninstall:feature -- <package>` (dry-run avec les comptes
réels ; `--yes` pour écrire, serveur arrêté, AVANT de retirer l'entrée de
config — le module doit rester résoluble).

- **Côté module** : `src/server/uninstall.sql`, le miroir destructif de ses
  migrations (`DROP TABLE IF EXISTS ft_<slug>_...`, idempotent — un échec au
  milieu se répare en relançant). Sentinelle des deux côtés (`gen:features`
  ET le script) : il ne peut toucher QUE le préfixe du module — l'allowlist
  des tables historiques d'une native rapatriée ne s'applique pas ici, ces
  tables sont des données de l'app.
- **Côté app**, le script nettoie ce qu'aucun module ne voit : `feature_kv`,
  les enregistrements `_migrations` (`<id>/...`), `notification_channels` et
  `notification_routes` (liaisons par cascade), `item_shares` et
  `item_role_grants`, les grants dans le JSON `workspace_roles.features`
  (droit + extras + canaux), et la feature dans chaque
  `workspaces.home_layout` (tuiles, dossiers, mini-widget de topbar). Le
  journal d'audit reste : c'est de l'histoire, pas une dépendance.
- La part pure (nettoyages JSON, sentinelle SQL) vit dans
  `scripts/lib/uninstall.ts`, testée par `npm test`.
- **Conséquence assumée** : les tables en allowlist survivent à la
  désinstallation, même quand elles ne servent qu'au module (les `sync_*` de
  CloudSync). C'est le prix de la règle « un module ne détruit jamais une
  table du schéma public » ; les retirer vraiment demanderait un second
  temps, une migration du socle.

## Ce que le contexte serveur expose, en une liste

Par requête (`SdkFeatureContext`, construit dans `_sdk/context.ts`) : l'identité
de l'appel (`userId`, `workspaceId`, `workspace`, `isOwner`, `canWrite`,
`canExtra`/`extraValue` par `resolveExtras`, la même règle que le harnais),
`repo`, `store` (KV chiffrable, `'server' | 'private' | 'none'`), `cipher(mode)`,
`deveye` (façade gardée par `nativeCapabilities` : `notify`, `mail.accounts`,
`members.read`, `devices.read`, `agents`), `transport` (socket appelant,
`agents`), `audit`, `logger`, `requestId`. Une erreur se signale par
`FeatureError(code, message)`.

Par service (`FeatureServiceDeps`, `_sdk/service.ts`) : `repo`,
`listWorkspaceIds` (tous les espaces), `storeFor`/`cipherFor`/`deveyeFor`/
`devicesFor` (sessionless, étage ouvert seul ; `devicesFor` est la vraie façade,
gardée par `devices.read`, avec l'état en ligne du hub), `audit` (source
système), `agents`, `keys` (`sealBytes`/`openBytes` sous la clé serveur),
`createTicker` (boucle avec garde de réentrance), `logger`. Les hooks agent
d'un module qui échouent sont isolés et journalisés (`moduleAgentHooks`), deux
modules offrant le même provider sont refusés au boot, et
`validateGrantExtras` vérifie les extras d'un rôle contre les manifests.

Pairs admis d'un module : `@deveye/types`, `react`, `zod`, `framer-motion`
(déclarés en `peerDependencies`, résolus depuis l'app).

## Dettes connues

- **Partage inter-espaces et restrictions par élément** : au SDK depuis
  Uptime (`ctx.sharing.scope()`, `ctx.items.*`, `FeatureServer.items`, les
  harnais de test qui les simulent par `shares` et `itemRestrictions`). Ce qui
  reste : les modules **externes** déclarent `shareTier: 'never'` tant
  qu'aucun module tiers n'a exercé le contrat (une ligne de `validateManifest`
  à lever le jour venu), et les `'perItem'` natifs (Notes, Mail, Projets)
  restent à brancher, chacun étant un chantier en soi (SHARING.md §9).
