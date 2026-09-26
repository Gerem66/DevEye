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
`features/*` (workspaces npm) et passent par le même chemin : Météo a été la
première, la preuve que le contrat suffit ; Appareils la seizième et dernière.

## Les trois étages

1. **`@deveye/types/sdk`** (publié) : le contrat. Ids `x-<slug>` pour les
   modules externes, l'id natif pour une native rapatriée, `FeatureManifest`
    - `validateManifest`, le contexte serveur (`SdkFeatureContext`,
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
   générateur. Une table de module qui référence `devices.id` par une clé
   étrangère lit la collation de cette colonne dans `INFORMATION_SCHEMA` au
   moment de se créer (`CONCAT` + `PREPARE`, patron de la 098) : ni déclarée
   en dur, ni héritée du défaut de la base, les deux cassent la clé sur une
   base restaurée d'un dump, où `devices` arrive avec sa collation épinglée.
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
rattachée à l'espace par la 048), pas de service, pas de réglages. Ce que sa
migration a retiré : la commande `password.unlock` et son
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
et 015, complétées jusqu'à la 036), pas de service, pas de réglages. Ce que
sa migration a décidé : le **renommage franc** de ses
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
topbar et celles de `SHARE_WIRED_FEATURES`, `LIST_KEYS` et
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
`ctx.deveye.devices.list` rend les appareils de l'espace et ceux qui y sont
projetés), la **façade agents** (`requestScan`, `pushConfig`) et le
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

**Les Sauvegardes** sont la huitième native rapatriée (`features/backup`, 28
août 2026), et la première à consommer une native encore dans l'app : elle
inaugure côté module les **providers dans les deux sens** (`ctx.providers.get`
et `deps.providers.get` ; `registerNativeProvider` côté app pour ce que Bases
de données offre tant qu'elle est native, `DATABASE_BACKUP_PROVIDER` : bases
nommées et accès ouvert, tunnel compris, le module ne déchiffrant aucune
connexion), la **façade agents « fichiers »** (`requestFilesMutate`,
`requestFilesUpload`, `awaitFilesOp`, `cancelFilesOp`, `buffered` : les ordres
de l'explorateur, ce qui fait d'une machine enrôlée une destination sans
changer l'agent), la **clé dérivée** (`keys.derive`, HKDF sur la clé serveur,
la dérivation que `scripts/restore-backup.mjs` refait sans DevEye), l'**onglet
Chiffrement d'un module** (`settings.item: ['encryption']` + `settingsPanels.encryption`),
le **format DEVB dans le SDK** (`@deveye/types/sdk/server`, partagé avec
CloudSync, dont le dernier alias vers l'app disparaît), et la **migration d'un
module sur ses tables historiques** (`backup/001` : la clé étrangère des
travaux cascade, `workspace.delete` ne bute plus dessus). Ce que sa migration a
réglé : le dialogue des destinations et l'onglet Chiffrement sont des panneaux
du manifest, le « + » du dialogue de travail est le bouton commun
(`onOpenChange` pour l'adoption), `useResource` remplace les chargeurs maison,
`humanizeError` et `formatBytesFr` les copies locales, les variables
`BACKUP_*` sont lues par le module, la commande fantôme
`backup.testNotification` sort de `NON_MUTATING`, et le genre d'une
destination se choisit en segments.

**Les Bases de données** sont la neuvième native rapatriée
(`features/database`, 28 août 2026), et la première dont un module et une
native se lisent **mutuellement par contrat** : le module publie sur son
service ce que l'app enregistrait pour lui (`DATABASE_BACKUP_PROVIDER`, lu
par Sauvegardes : `registerNativeProvider` et `backupProvider.ts` ont
disparu d'`app.ts`) et ce que Projets lui demande avant de relier une base
(`DATABASE_ITEMS_PROVIDER`, le miroir d'`UPTIME_ITEMS_PROVIDER`, lu par
`moduleProvider` dans `project/databaseLink.ts`) ; dans l'autre sens, l'app
offrait `PROJECTS_USAGE_PROVIDER` tant que Projets était native
(`project/usageProvider.ts`, enregistré dans `app.ts` par
`registerNativeProvider`, que le service du module Projets publie depuis son
rapatriement : les projets de l'espace qui relient un élément, avec leur titre,
et combien par élément, clé par feature reliée), et le module ne lit plus
aucune table de Projets
(`project_count` a quitté son dépôt, `toDatabase` reçoit le compte ; la
table de liaison `project_database_links` et ses lectures ont rejoint
`db/repos/projectLinks.ts`, à côté des services surveillés). Le service de
fond (`DatabaseMonitor` sur `FeatureServiceDeps` : un ticker, `cipherFor`
mémoïsé par le SDK, `deveyeFor(ws).notify.send(alert, { itemId })` sur la
route de chaque base, `live.changed` à chaque relevé) accepte une couture de
test (`{ openSession }`), et ses fonctions pures (`compare`, `runConditions`,
`isFiring`, `renderMessage`) vivent dans `rules.ts`, partagées avec l'essai à
blanc. Ce que sa migration a réglé : la dette de la coquille (le relevé et
sa cadence, le chargement des tables sont un panneau Général à l'échelle de
la base, les alertes un onglet personnalisé `alerts` ; la fiche garde l'état
des alertes, pas leur écriture), l'entrée native de `SHARE_WIRED_FEATURES`
et les `case 'database'` des switchs de partage et de routage (l'entrée
`items` du module les remplace), et le barrel client, élargi de `openFeature`
et `useRequestPopupWidth` pour l'onglet d'un projet composé par
`DATABASE_CLIENT_PROVIDER`. Ce que le SDK n'offre pas : un `mutates`
multi-sujets (`database.remove` déclarait `['database', 'projects']` ; un
module ne nomme que son sujet, le tableau d'un projet et ses compteurs
d'onglets se remettent à jour à leur prochaine lecture).

**Déploiements** est la dixième native rapatriée (`features/deploy`, 28
août 2026), menée par deux agents en parallèle (serveur + app, client +
écrans natifs), et la première dont le service **entretient un message** :
sa migration a élargi la façade `notify` d'un suivi vivant
(`liveChannels({ itemId })` : les canaux d'une route capables de porter un
message qui se modifie, Discord aujourd'hui ; `postLive(channelId, message,
messageId?)` : publie sans identifiant, modifie avec, rend l'identifiant à
garder ou `null` quand le canal refuse ; `send(alert, { except })` : l'avis en
texte sans les canaux qui ont déjà conclu), implémenté dans la façade et
enregistré par le harnais (`recorded.liveMessages`, option `liveChannels`).
Ses clés Dokploy ont quitté `workspace_credentials` pour une table du module
par une migration du SOCLE (`099` : le socle crée et copie, identifiants
conservés, un module ne pouvant pas écrire dans une table du socle ; la clé
étrangère `fk_deploy_target_credential` retirée et non recréée, le ménage
devenant explicite dans le dépôt), `_credentials.ts` et `repos/credentials.ts`
ne connaissant plus que GitHub. Le contrat de Projets a gagné `recordEvent`
(la frise d'un projet pour un déploiement parti de son onglet : la seule
chose qu'un module ait à DIRE à Projets), et `project_deploy_links` a rejoint
`db/repos/projectLinks.ts` avec ses six lectures ; dans l'autre sens,
`DEPLOY_ITEMS_PROVIDER` est publié par le service du module et lu par
`project/deployLink.ts`, `DEPLOY_CLIENT_PROVIDER` composé par l'onglet d'un
projet. Le barrel client a gagné `Avatar` et `useWorkspaceMembers` (qui a
déclenché quoi, montré sans lire la table des membres). Le service
(`DeploySync` sur `FeatureServiceDeps`, l'ex moitié déploiement
d'`IntegrationSyncService`, qui ne garde que les dépôts git) accepte une
couture de test (`{ listDeployments, listTargets, fetchDeploymentLog }`) ;
la déclaration ambiante de `ws` reste dans `src/types` (incluse par le projet
serveur des modules). Ce que le SDK n'offre pas, deux fois de plus : un
`mutates` multi-sujets (`deploy.remove` et `deploy.trigger` déclaraient
`['deploy', 'projects']`) et un `live.changed` sur un autre sujet que le sien
(le service natif diffusait `['deploy', 'projects']`) : l'onglet d'un projet
suit `deploy.detail` et voit l'état changer, ses compteurs se relisent à
leur prochaine ouverture.

**Git** est la onzième native rapatriée (`features/git`, 28 août 2026),
menée par deux agents en parallèle (serveur + app, client + écrans natifs).
Ses jetons GitHub ont quitté `workspace_credentials` pour une table du module
par une migration du SOCLE (`100` : le socle crée `ft_git_credentials`, copie
les jetons, identifiants conservés, retire la clé étrangère
`fk_git_repo_credential` sans la recréer, puis SUPPRIME la table commune, qui
n'avait plus qu'un propriétaire) : `_credentials.ts`, `db/repos/credentials.ts`
et l'entrée `credentials` de `db/index.ts` ont disparu avec elle, le ménage
d'un jeton retiré étant explicite dans le dépôt du module (`removeCredential`
met ses dépôts à NULL avant de retirer la ligne). `IntegrationSyncService`
n'existe plus : sa moitié git est `GitSync` sur `FeatureServiceDeps` (un
ticker du SDK à deux minutes, `cipherFor` mémoïsé, `live.changed`, la tranche
de backfill toujours enchaînée par un `setTimeout(...).unref()` parce que ce
n'est pas une boucle), avec une couture de test (`{ github }`, les six
lectures de l'adaptateur), et `ctx.integrations` a quitté `FeatureContext`,
`WSDeps` et `app.ts`. Le contrat de Projets a gagné `applyVersion(feature,
itemId, ws, version)` : l'ex `applyReleaseVersion` du service, côté Projets
(le module dit la dernière release stable, Projets réécrit la version des
projets liés de l'étage ouvert dont `versionSource` est `github_release`,
la seule source suivie aujourd'hui) ; `project_repo_links` a rejoint
`db/repos/projectLinks.ts` avec ses six lectures, et `project_count` a quitté
le dépôt du module (`toRepo` reçoit le compte). Dans l'autre sens,
`GIT_ITEMS_PROVIDER` est publié par le service du module et lu par
`project/repoLink.ts`, `GIT_CLIENT_PROVIDER` composé par l'onglet d'un projet.
Ce que sa migration a élargi : la façade `members.list()` rend la **couleur**
du compte (`color`, `null` sur un compte jamais colorié), la seule donnée
d'utilisateur que le graphe des commits lisait dans la table `users` (un
auteur rattaché prend la couleur de sa présence en direct), et Git déclare
donc `members.read` (le rattachement d'un auteur vérifie aussi l'appartenance
par la façade, l'ex `workspaceMembers.isMember`) ; le barrel client a gagné
`userColorVar`. Ce que le SDK n'offre pas, une fois de plus : un `mutates`
multi-sujets (`git.repoRemove` déclarait `['git', 'projects']`) et un
`live.changed` sur un autre sujet que le sien (le service natif diffusait
`['git', 'projects']` parce qu'une release peut changer la version d'un
projet lié) : l'onglet d'un projet suit `git.repo`, la version d'un projet se
relit à sa prochaine lecture.

**Audience** est la douzième native rapatriée (`features/audience`, 28 août
2026), menée par deux agents en parallèle (serveur + app, client + écrans
natifs), et la première à ouvrir des **routes HTTP publiques**. Sa migration
a élargi le SDK de la capacité `'routes.public'` et de
`FeatureService.publicRoutes(app: SdkPublicApp)` : le module déclare ses
routes (`get`/`post`, un `rateLimit` par route quand il en veut un, une
requête réduite à `headers`/`body` déjà décodé/`ip`, une réponse chaînable
`header`/`code`/`send`), l'hôte les monte sur chacun de ses écouteurs exposés
(`modulePublicRoutes(app)` dans `app.ts` et `publicApp.ts`, journal
silencieux, plafond de débit par route) et retient leurs chemins pour son
délégateur CORS (`isModulePublicPath`, à la place des chemins en dur) ;
`buildPublicApp()` n'a plus de dépendance, le second écouteur ne sert que ces
routes. Le contexte des deux côtés porte `origins { app, public }` (l'ex
`ingestOrigin()` : `AUDIENCE_ORIGIN` sinon `PUBLIC_ORIGIN`, sans barre
finale, ce qu'un module donne à copier ne se déduit jamais du navigateur), et
le harnais le simule (`createTestContext({ origins })`). Les **sels** des
visiteurs ne sont plus la clé serveur brute (`CRYPT_KEY_A`), qu'un module ne
lit pas : le service dérive une fois `deps.keys.derive('audience',
'visitor-salt', 32)` et s'en sert dans le condensé persistant comme dans le
sel du jour ; conséquence assumée, les condensés de visiteurs ont changé une
fois à la migration (un visiteur persistant compté « nouveau » une fois, les
condensés anonymes tournaient déjà chaque jour). Le service (`AudienceIngest`
sur `FeatureServiceDeps` : deux tickers, `cipherFor` de l'hôte, `live.changed`
avec la coalescence à la minute gardée dans le module, `stop()` attend la
dernière vidange puisque l'hôte attend l'arrêt avant de fermer le pool) se
teste sans horloge ni réseau sur le harnais. `project_audience_links` a
rejoint `db/repos/projectLinks.ts` (`listSiteIds`, `linkSite`, `unlinkSite`,
`unlinkAllSites`, `listSiteUsage`, `countSiteLinks`), `usageProvider.ts` a
gagné l'entrée `audience`, et `project_count` a quitté le dépôt du module
(`toSite` reçoit le compte du contrat de Projets) ; dans l'autre sens,
`AUDIENCE_ITEMS_PROVIDER` est publié par le service et lu par
`project/audienceLink.ts`, `AUDIENCE_CLIENT_PROVIDER` composé par l'onglet
d'un projet. Les trois dépôts natifs (sites, entonnoirs, ingestion) sont un
seul `AudienceRepo` sur `SdkQueryable`, sections gardées. Avec elle disparaît
la dernière native branchée au partage : `itemHomeWorkspace` (sharing) et
`itemLabelOf` (notify) n'ont plus de `switch` natif, seulement `moduleItems`.
Le barrel client a gagné `useStickyOffset`. Ce que le SDK n'offre pas, une
fois de plus : un `mutates` multi-sujets (`audience.siteRemove` déclarait
`['audience', 'projects']`) ; les compteurs d'onglets d'un projet se relisent
à leur prochaine ouverture.

**Mail** est la treizième native rapatriée (`features/mail`, 28 août 2026),
menée par deux agents en parallèle (serveur + app, client + écrans natifs),
et la première à vivre sur les **deux étages par élément** : une boîte
ouverte se lit sans session et se relève en fond, une boîte gardée exige le
déverrouillage (`cipherFor(ctx, tier)` : `ctx.cipher()` ou
`ctx.cipher('private')`, `assertMailUnlocked` par `ctx.secrecy.isUnlocked()`,
`assertTierAllowed` par `ctx.workspace.kind`). Sa migration a élargi le SDK
du **ticket de session** : `ctx.secrecy.ticket(payload, { ttlSeconds })`
signe (par l'hôte, `signModuleTicket` dans `auth/jwt.ts`, l'audience liée au
module) ce qu'un module tend au navigateur (l'URL d'une pièce jointe, le
`state` OAuth), et `deps.secrecy.redeem(ticket)` le rend à une route publique
du service en `{ userId, workspaceId, payload, cipher: { server, private |
null } }`, l'étage gardé tant que la session est déverrouillée ; l'ex
`signMailAttachmentToken` / `signMailOAuthState` de `auth/jwt.ts` et
`cipherForTier` (qui reconstruisait le magasin gardé depuis l'identifiant de
session) ont disparu. Avec lui : `keys` au contexte de requête (les mêmes
dérivations qu'un service), `deps.origins` côté service (le `redirect_uri` et
la cible du `postMessage` de la page de retour), `SdkPublicRouteOptions.exposure`
(`'app'` : l'origine de l'app seulement, l'écouteur public ignore la route ;
les deux de Mail le déclarent), `SdkPublicRequest.query` (la chaîne de
requête décodée, `unknown` comme `body` : ce qu'un GET à ticket porte), et le
harnais qui simule tout cela (`createTestContext().secrecy.ticket` pose un
ticket lisible, `createTestServiceDeps().secrecy.redeem` le relit, verrou
compris). Le **transport des alertes e-mail** est un provider : le service
publie `MAIL_TRANSPORT_PROVIDER` (`listSenders`, `isReady`, `send`, les
comptes ouverts et actifs sous le codec ouvert), `Services/notifications.ts`
le relit à l'appel par `moduleProvider` (sans module, aucun canal e-mail
n'est prêt) et la façade `mail.listAccounts` par `providers` (`FacadeDeps`
en a gagné une entrée) ; `db.mailAccounts` et les trois autres dépôts natifs
ont quitté `db/index.ts`, `MailSyncService` et les deux routes montées à la
main ont quitté `app.ts` et `index.ts`, `MAIL_SYNC_*` et `OAUTH_*` ont quitté
`Utils/Env` pour `features/mail/src/server/env.ts`. Le manifest inaugure
l'onglet **`sync`** (échelle d'un élément : la cadence et la maintenance
d'une boîte) à côté de `general` et `encryption`, et retire les trois tables
de câblage natif de la coquille dont Mail était le dernier occupant ; le
barrel client a gagné `WsError` et `touchSecrecy`. Le service (`MailSync`
sur `FeatureServiceDeps` : un ticker, `deps.cipherFor`, `deps.live.changed`
aux transitions, l'échéance par compte), les routes et le transport se
testent sans réseau (couture `{ mailClient }` du service, `{ client, oauth }`
des routes). Comme les Notes, le manifest déclare `shareTier: 'never'`
par-dessus le `'perItem'` du descripteur : le listage n'est pas branché sur
le partage, aucune entrée `items`.

**Projets** est la quatorzième native rapatriée (`features/projects`, 28
août 2026), menée par deux agents en parallèle (serveur + app, client +
écrans natifs), la deuxième sur les **deux étages par élément** (l'ex
`cipherFor(ctx, tier)` de `_shared.ts` rend `ctx.cipher()` ou
`ctx.cipher('private')`, `assertProjectUnlocked` par `ctx.secrecy.isUnlocked()`,
un projet gardé se liste masqué et répond `locked` en détail et en écriture,
sa conversion d'étage re-chiffre tout l'arbre dans le module, `repo/rekey.ts`)
et la première à battre **deux sujets** : `projectsChat`, longtemps un sujet
natif de `@deveye/types` (`nativeLiveTopicSchema`, `TOPIC_FEATURE`), est le
premier sujet secondaire déclaré par un manifest (`topics: [{ id, keys }]`,
validé au boot par `buildTopicIndex` contre `moduleTopics()`), et `mutates`
admet une liste (`['projectsChat']` sur la discussion, `['projects', 'git']`
sur une liaison : les siens, un secondaire, celui d'une autre feature), comme
`deps.live.changed(workspaceId, topics?)` côté service. Ses commandes et ses
clés sont passées de `project.*` à `projects.*` (un module parle sous son id ;
les genres d'événements stockés suivent par la migration `001` du module, sur
une table de l'allowlist), ses contrats vivent dans `src/contracts/` et
`@deveye/types` n'en garde que `projectStatusSchema` et le descripteur. Le
provider d'usage (`PROJECTS_USAGE_PROVIDER`) est **publié par le service du
module** : `registerNativeProvider` et `NATIVE_PROVIDERS` ont disparu de
`register.ts` avec leur dernier utilisateur, l'app n'offre plus aucun contrat
elle-même, et `moduleProvider` ne cherche que parmi les services des modules.
Dans l'autre sens, le module lit les cinq contrats d'éléments
(`*_ITEMS_PROVIDER`) par `ctx.providers.get`. Ce que le SDK n'offrait pas aux
quatre modules précédents (un `live.changed` sur le sujet `projects` après une
release reportée ou un déploiement inscrit dans une frise), Projets le fait
lui-même depuis son contrat (`applyVersion`, `recordEvent`), et les sept dépôts
natifs (`db.projects`, `projectBoard`, `projectChat`, `projectPlan`,
`projectHistory`, `projectLinks`, `projectRekey`) ont quitté `db/index.ts` pour
`repo/*.ts` sur `SdkQueryable`, la jointure d'ordre sur la table d'une feature
reliée admise comme avant. Les assignés et les mentions passent par
`members.read`. Le module se teste sur le harnais (45 tests : handlers et
contrat publié), là où la native n'en avait aucun. Comme les Notes et Mail, le
manifest déclare `shareTier: 'never'` par-dessus le `'perItem'` du
descripteur : aucune entrée `items`.

**Appareils** est la seizième native rapatriée (`features/devices`, 29
août 2026), et la dernière : seize sur seize, la liste est close. Tenue pour
de l'infrastructure jusque-là (44 commandes, un hub de mille lignes, des
tables écrites hors session), elle a été migrée en coupant au bon endroit
plutôt qu'en enveloppant le hub :

- **Infrastructure, dans `src/`** : le hub, la socket agent, l'ingestion de la
  télémétrie et la présence (qui écrivent `devices`, `device_metrics`,
  `device_process_samples`, `device_presence` hors session, pour trois
  consommateurs : l'app, Sentinelle, Sauvegardes), l'enrôlement et la
  distribution des binaires, la composition de `agent.config`, la garde
  `authorizeDevice` (une seule, `src/agent/authorize.ts`, que la façade SDK
  ne duplique plus), et les **23 commandes de transport** `agent.*`
  (`src/features/agent/`) qui ne font que relayer une méthode du hub :
  natives, sous le droit `devices`.
- **Module `features/devices`** : la flotte de l'espace (liste, appairage,
  approbation, révocation, renommage, rangement, configuration de collecte,
  suppression ; le partage entre espaces est celui de la coquille commune,
  `item_shares`), l'historique stocké (métriques,
  présence, processus, disponibilité, instantanés, épinglage, stockage), les
  **codes de liaison** (quatre routes HTTP de session devenues les commandes
  `devices.linkCode*`, l'enrôlement public restant en HTTP), la rétention
  (le balayage horaire d'`index.ts` devenu `RetentionSweep` sur
  `deps.createTicker`, `MONITORING_RETENTION_DAYS` lue par le module), et
  tout le client : Monitoring, la page Appareils et la tuile d'appareil de
  l'accueil, offerte par `DEVICES_CLIENT_PROVIDER` (`useDevices`,
  `DeviceWidget`). Le dialogue de configuration
  de collecte et les réglages du terminal sont devenus les deux onglets d'un
  appareil dans la coquille de réglages : la dernière dette de `SETTINGS.md`
  tombe avec eux.
- **Tables partagées, assumé** : les dépôts du socle restent à
  l'infrastructure, réduits à ce qu'elle écrit et à ce que la façade lit ; le
  module a son dépôt sur les mêmes tables allowlistées, un fichier par table.
  Deux lecteurs, un schéma.

Ce que le SDK a gagné : `ctx.isAdmin` et `access: { admin: true }` (le
dispatcheur exige l'administrateur global en plus du droit de feature ; les
appareils n'en relèvent plus, mais les pages système oui) ; la capacité
`workspaces.read` (`ctx.deveye.workspaces.list`, administrateur seulement) ;
sur la façade `agents`, les trois ordres du cycle de vie
(`resetAgentSession`, `disconnectAgent`, `requestDestroy`) et
`servedManifest()` (le manifest des binaires servis, pour signaler un agent
à mettre à jour sans que le module ne lise le disque) ; côté client,
`SettingsPanelProps` (la portée d'un élément de la coquille porte un id
texte, un appareil étant un UUID), `commandsApi` (les commandes `agent.*`
typées), `acquireMetrics` / `releaseMetrics`, `joinPath`, et le contrat
`DEVICES_CLIENT_PROVIDER`. Le module se teste sur le harnais (37 tests :
handlers et service), là où la native n'en avait aucun. Voir
[Appareils](../features/devices/README.md) pour la carte et les invariants.

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
  `feature_domains`, les enregistrements `_migrations` (`<id>/...`), `notification_channels` et
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
de l'appel (`userId`, `workspaceId`, `workspace`, `isOwner`, `isAdmin`,
`canWrite`, `canExtra`/`extraValue` par `resolveExtras`, la même règle que le
harnais ; une commande qui exige l'administrateur global le déclare par
`access: { admin: true }`, appliqué par le dispatcheur),
`repo`, `store` (KV chiffrable, `'server' | 'private' | 'none'`), `cipher(mode)`,
`deveye` (façade gardée par `nativeCapabilities` : `notify` avec `embeds`
Discord, `except`, et le suivi vivant `liveChannels` / `postLive`, `mail.accounts`, `members.read` (chaque membre avec la couleur de son compte), `devices.read` (des `SdkDevice`
complets : état, propriétaire, espace, cadence, rapport ; `authorize` est LA
garde de l'app, et avec `{ extras }` elle éprouve les permissions d'Appareils
de l'appelant sur CET appareil, surcharges comprises, qu'un module ne peut pas
nommer dans son `access` ; `list()` rend les appareils de l'espace et ceux qui
y sont projetés, l'administrateur global compris), `workspaces.read` (`list()`, tous les
espaces, administrateur seulement), `telemetry.read` (`snapshot`,
`pinInstant`, réservée aux ids natifs) et `agents` (`requestScan`,
`pushConfig`, les trois ordres du cycle de vie `resetAgentSession` /
`disconnectAgent` / `requestDestroy`, `servedManifest`, les requêtes sync,
`dockerRun` / `dockerInventory`, et `archiveFolder` : l'archive `.tar.gz` d'un
dossier, faite par l'agent et tirée par crédits au rythme du consommateur,
annulée sur la machine quand on quitte la boucle)),
`transport` (socket appelant, `agents`), `live.publish(event, payload)` (la voie
de poussée, capacité `live.publish` : une trame nommée sous le préfixe du module,
aux connexions de la salle qui ont `read` sur sa feature ; voir LIVE.md §4),
`secrecy.isUnlocked()` (le verrou de la session) et
`secrecy.ticket(payload, { ttlSeconds })` (le ticket de session qu'une route
publique du service rend contre les codecs de l'appelant), `keys` (les mêmes
dérivations qu'un service),
`items` (`restrictions()`, `assert(itemId, level)`, `forget(itemId)` : les
restrictions du dispatcheur liées à LA feature du module, et le ménage d'un
élément supprimé), `sharing.scope()` (les projections vers l'espace actif,
`shareScope` de `_sharing.ts` ; refusé sous `shareTier: 'never'`), `audit`,
`domains` (`list()`, `get(id)`, `verified()` : les domaines de LA feature du
module dans l'espace actif ; refusé sans `domains` au manifest), `logger`,
`requestId`, `origins { app, public, site }` (où vit DevEye, sans barre finale :
l'origine des membres, celle de l'écouteur public, et le site vitrine où vivent
les pages légales, `null` sans site). Une erreur se signale par
`FeatureError(code, message)`.

Par service (`FeatureServiceDeps`, `_sdk/service.ts`) : `repo`,
`listWorkspaceIds` (tous les espaces), `storeFor`/`cipherFor`/`deveyeFor`/
`devicesFor` (sessionless, étage ouvert seul ; `devicesFor` est la vraie façade,
gardée par `devices.read`, avec l'état en ligne du hub), `membersFor` (les
membres d'un espace, propriétaire compris, gardé par `members.read` : le nom
qu'une page publique montre), `devices` (la flotte
par identifiant, même garde), `telemetry`, `live.changed(workspaceId, topics?)`
(le sujet du module, ou ceux que le service nomme : les siens, un secondaire du
manifest, celui d'une autre feature ; diffusé par le hub, projections
comprises) et `live.publish(workspaceId, event, payload)` (la même voie de
poussée qu'en requête, l'espace étant nommé faute d'appelant), `audit` (source
système), `agents`, `access` (ce qu'un membre peut faire MAINTENANT, sans
session, pour un travail qui s'exécute en son nom : `feature(ws, userId,
{ level, extras, itemId })` pour la feature du module, `device(ws, userId,
deviceId, extras)` pour les permissions d'Appareils sur une machine, sous
`devices.read` ; un verdict `{ ok }` ou `{ ok: false, reason }`, relu à
chaque appel), `keys` (`sealBytes`/`openBytes` sous la clé serveur,
`derive(salt, info, length)` : HKDF sur la même clé, jamais stockée),
`secrecy.redeem(ticket)` (le ticket d'un module rendu en `{ userId,
workspaceId, payload, cipher: { server, private | null } }`), `origins`,
`domains` (`findByHost(host)` tous espaces confondus, `get(workspaceId, id)`,
`listVerified(workspaceId)` : de quoi router une requête entrante par son nom
d'hôte), `createTicker` (boucle avec garde de réentrance), `logger`. Un service peut
aussi déclarer `publicRoutes(app: SdkPublicApp)` (capacité `'routes.public'`) :
l'hôte monte ces routes sur chacun de ses écouteurs exposés, hors session
(`exposure: 'app'` pour n'en monter une que sur l'origine de l'app ; la
requête porte `headers`, `body` et `query` décodés, `ip`). Une route qui
reçoit un fichier se déclare par `postStream` : le corps n'est ni décodé ni
tamponné, l'hôte le rend en flux (`body.bytes()`) et coupe la connexion au-delà
du `maxBytes` déclaré, dans un contexte Fastify à lui où aucun parseur n'est
enregistré. Elle ne se monte que sur l'origine de l'app (`exposure: 'app'`,
obligatoire et littéral), reste hors des chemins que le délégateur CORS élargit,
et s'authentifie par un ticket (`features/convert/src/server/routes.ts`). Les hooks agent
d'un module (connexion, télémétrie après persistance, sync) qui échouent sont
isolés et journalisés (`moduleAgentHooks`), deux modules offrant le même
provider sont refusés au boot, et `validateGrantExtras` vérifie les extras
d'un rôle contre les manifests.

Par entrée serveur (`FeatureServer`) : `items` (`homeOf`, `labelOf`,
`shareable` facultatif pour une feature à palier par élément), ce que
les commandes transversales de partage et de routage savent des éléments d'un
module (`moduleItems` dans `register.ts`, consulté avant les switchs natifs),
obligatoire dès que le manifest déclare un `shareTier` autre que `'never'`
(`isModuleShareWired`). Son entrée `move`, elle, reste facultative en toute
circonstance : c'est elle qui autorise un élément à changer d'espace
(`isModuleMovable`), et son absence est la réponse sûre, pas un oubli.

Toujours par entrée serveur : `domains` (`records`, `probe`, `useCount` et
`onRemoved` facultatifs), obligatoire quand le manifest déclare `domains` et
refusée sinon (`registerModules`). La vérification a deux étages. La propriété
est l'affaire du socle : un TXT `_deveye.<hôte>` portant
`deveye-<slug>=<jeton>`, relu par `Services/domains/engine.ts`. Le service est
celle du module : sa `probe` n'est appelée qu'une fois la propriété acquise, et
rend une phrase plutôt que de lever. Un domaine vérifié ne retombe qu'au
troisième échec d'affilée, à l'un ou l'autre étage. La table est
`feature_domains` (hôte unique par fonctionnalité, tous espaces confondus), la
passe de fond `Services/domains/verifier.ts` (env `DOMAIN_PROBE_TICK_SECONDS`,
`DOMAIN_OK_SECONDS`, `DOMAIN_PENDING_SECONDS`), et les crochets reçoivent un
contexte sans session (`FeatureDomainsContext` : `repo`, `origins`,
`cipherFor`, `storeFor`, `keys`, `dns`, `logger`). `onRemoved` passe avant la
suppression : s'il lève, le domaine reste.

Un manifest dont les domaines servent des pages déclare `domains.web: true`
(Rendez-vous, Facturation, Uptime). Le socle ajoute alors, entre la propriété et la
sonde du module, ses propres contrôles (`Services/domains/web.ts`) : le nom
pointe vers l'origine publique, puis y répond en HTTPS avec un certificat
valable, chacun avec sa phrase. Ces noms sont ceux que Traefik lit sur
`/api/domains/proxy` (`Services/domains/proxy.ts`, env `DOMAIN_PROXY_*`) pour
obtenir seul leurs certificats ; un certificat qui arrive laisse le service
`pending`, pas `failed`. Ils se comptent à la limite d'offre `domains.hosts`
(`QUOTAS.md`), et `domain.list` rend le mode des certificats (`https`) et cette
limite (`quota`). La sonde du module n'a plus qu'à prouver que c'est cette
installation qui répond : un jeton servi sous `/.well-known/deveye-<slug>`, et
chaque route publique ne sert, sous un domaine client, que l'espace qui le
possède.

La racine d'un domaine client (`GET /`) appartient à l'hôte : aucun module n'y
monte de route (refusé au boot). Un service qui veut y répondre, pour un nom qui
EST la page (`statut.exemple.fr` d'une page de statut d'Uptime), déclare
`domainRoot(req, reply, domain)` (capacité `'routes.public'` et `domains.web`
exigés). `modulePublicRoutes` monte `GET /` sur les deux écouteurs : un hôte qui
n'est pas une origine de DevEye et qu'un module a VÉRIFIÉ (pas seulement
pointé : le proxy reçoit aussi ceux-là) va au premier module installé qui sert
sa racine, derrière la garde de maintenance ; tout le reste retombe sur le
repli de l'écouteur, le client sur l'app (d'où `index: false` à
fastify-static, qui enregistrait sinon `/` lui-même) et 404 sur la surface
publique. Le module route par le `domain` reçu, jamais par l'en-tête.

L'hôte sert aussi, sur les deux écouteurs et donc sous tout domaine client,
l'icône de DevEye en 64 pixels à `DEVEYE_ICON_PATH` (`/deveye-icon.png`,
`src/assets/deveye-icon.png`) : l'icône d'onglet d'une page publique qui n'en a
pas à elle. Une adresse et non une URL de données, que les aperçus de lien et
les robots savent suivre ; une page qui pose sa politique y ajoute
`img-src 'self'`.

Toujours par entrée serveur : `env`, la spec des variables d'environnement
que le module lit (`defineModuleEnv`, lue par `readModuleEnv` : entier, texte,
chemin, adresse, drapeau, choix, secret). Un module lit ses variables lui-même,
jamais par `Utils/Env`, et chacune a un défaut qui marche. L'hôte relit la même
spec au démarrage (`warnUnsetModuleEnv`, en tête de `main()`) et écrit un
avertissement par module qui nomme chaque variable absente ou illisible, avec
la valeur appliquée : un défaut qui devine le monde de l'exploitant (l'adresse
du site, un dossier) se lit au démarrage au lieu de se découvrir en production.
Une variable posée vide compte comme posée ; `optional` fait taire celles
qu'une installation peut ne pas utiliser (clés OAuth, Stripe, certificat
fourni) ; un secret n'est jamais écrit. Une spec mal formée arrête le démarrage
(`registerModules`).

Par entrée client (`FeatureClient`) : `providers`, le jumeau client des
providers de service, que les écrans de l'app lisent par
`moduleClientProvider` (Projets compose ainsi les composants d'Uptime).

Pairs admis d'un module : `@deveye/types`, `react`, `zod`, `framer-motion`
(déclarés en `peerDependencies`, résolus depuis l'app).

## Dettes connues

- **Le site vitrine en trois exemplaires** : `ctx.origins.site` (`SITE_URL`)
  dit aux modules où vivent les pages légales, mais Uptime, Projets et
  Rendez-vous lisent encore chacun leur `*_SITE_URL` pour le lien de leurs
  pages publiques. Une seule variable suffirait ; le jour où on les retire,
  `origins.site` passe aussi aux routes publiques (`SdkPublicApp`).
- **Partage inter-espaces et restrictions par élément** : au SDK depuis
  Uptime (`ctx.sharing.scope()`, `ctx.items.*`, `FeatureServer.items`, les
  harnais de test qui les simulent par `shares` et `itemRestrictions`). Ce qui
  reste : les modules **externes** déclarent `shareTier: 'never'` tant
  qu'aucun module tiers n'a exercé le contrat (une ligne de `validateManifest`
  à lever le jour venu). Les trois `'perItem'` (Notes, Mail, Projets) sont
  branchés : `items.shareable` pour le palier, `ctx.items.forget` à la
  bascule vers le palier gardé, et pour Projets les trois décisions de
  SHARING.md §2 (membres hors espace masqués, projetés comptés dans « mes
  tâches », liaisons nommées en lecture).
