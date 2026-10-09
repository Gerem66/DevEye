# Le SDK des modules de features

Doc de **mainteneur** : le tiers qui développe un module lit la doc anglaise du
[template](https://github.com/Gerem66/DevEye-Feature-Template), celle-ci dit
comment l'app tient sa part du contrat.

## Le modèle

Un module est un **package compilé** : il vit dans son dépôt (créé depuis le
template), l'app le déclare dans `features.config.json`, et
`npm run gen:features` écrit la glue (committée, le serveur n'ayant pas de
build). Rien ne se charge à chaud ; installer = une dépendance npm + une entrée
de config + une génération. Les features de l'app vivent dans `features/*`
(workspaces npm) et passent par le même chemin qu'un module tiers ; les modules
privés s'installent par `features.local.json`, l'overlay gitignoré qui résout
un module par son chemin.

Un module ne s'installe jamais depuis l'interface. Importer un dossier depuis
l'écran reviendrait à téléverser du code qui s'exécute côté serveur avec tous
les droits du serveur (la base entière, les clés, les archives), et aucune
validation de manifest n'y change rien : le manifest peut être honnête et
`handlers.ts` malveillant. L'activation reste un geste d'administrateur au
déploiement, et un import à chaud demanderait un vrai bac à sable (processus
séparé, capacités restreintes), qui n'existe pas.

Une feature est **tout entière** dans son répertoire : ses contrats zod et son
domaine dans `src/contracts/`, son manifest dans `src/manifest.ts`, ses
handlers, son dépôt, ses migrations et ses services dans `src/server/`, ses
écrans dans `src/client/`. `@deveye/types` ne garde que l'identité d'une
feature de l'app (son id dans les enums, son descripteur dans
`src/domain/featureRegistry.ts` : ce que les écrans des autres doivent savoir
sans l'ouvrir) et les points de couplage déclarés (`src/sdk/providers.ts`, le
protocole des agents). Les commandes d'un module s'enregistrent au démarrage
par son manifest ; le registre natif ne les porte pas.

## Les trois étages

1. **`@deveye/types/sdk`** (publié) : le contrat. Ids `x-<slug>` pour les
   modules externes, l'id de l'enum pour une feature de l'app, `FeatureManifest`
   et `validateManifest`, le contexte serveur (`SdkFeatureContext`,
   `FeatureStore`, la façade `DevEyeFacade`), les contrats client
   (`FeatureClient`), les harnais de test (`createTestContext`,
   `createTestServiceDeps`). **C'est la surface publique** : elle se versionne,
   elle ne casse pas.
2. **Le serveur** : `src/features/_sdk/` adapte. `register.ts` projette les
   définitions SDK en `FeatureDefinition` natives (accès de LA feature + extras
   en enveloppe) : le dispatcheur ne sait pas qu'un module existe. `context.ts`
   est la frontière exacte de ce qu'un handler voit ; `store.ts` porte la règle
   de chiffrement du magasin clé-valeur (mode figé sur la ligne, `'private'`
   inexprimable côté services) ; `facade.ts` garde chaque appel aux natives
   derrière `nativeCapabilities` ; `service.ts` construit les
   `FeatureServiceDeps`. Migrations de modules : deuxième passe du runner
   (`src/db/migrate.ts`), après tout le socle, enregistrées `<id>/<fichier>`,
   tables `ft_<slug>_` vérifiées par le générateur ; les tables antérieures au
   préfixe sont listées dans le `deveye-feature.json` du module. Une table de
   module qui référence `devices.id` par une clé étrangère lit la collation de
   cette colonne dans `INFORMATION_SCHEMA` au moment de se créer (`CONCAT` +
   `PREPARE`, `features/deploy/src/server/migrations/002_device.sql`) : ni
   déclarée en dur, ni héritée du défaut de la base, les deux cassent la clé
   sur une base restaurée d'un dump, où `devices` arrive avec sa collation
   épinglée.
3. **Le client** : `client/src/sdk/index.ts` est le barrel servi sous l'alias
   `deveye-sdk-client`, LE seul import d'un module. `sdk/modules.ts` enregistre
   descripteurs et ressources au chargement, `sdk/registry.ts` les sert au
   catalogue, à la coquille de réglages, à `RoleDialog` et à la téléportation.

## La frontière stable / interne

**Un seul package, `@deveye/types`.** Une coupe `@deveye/sdk` séparée est la
cible à terme (audience et rythme de version différents) ; `src/sdk/` est
autonome, et la coupe sera mécanique le jour du premier module tiers.

Est stable : tout ce qu'exportent `@deveye/types/sdk*` et le barrel
`deveye-sdk-client`. Tout le reste est interne et peut bouger. Élargir la
surface = l'ajouter à l'un de ces deux endroits, mettre à jour le portrait typé
du barrel, publié DANS `@deveye/types` (`src/sdk/client-ambient.d.ts`, que le
template tire par une entrée `include` de son tsconfig), et la doc REFERENCE du
template. `npm run check:sdk` (dans `client/`) vérifie mécaniquement que le vrai
barrel honore ce portrait : une dérive casse la CI de l'app, jamais le build
d'un tiers. Jamais d'export « en douce » par un autre chemin.

Un module in-repo a un privilège de plus, commenté à chaque usage : il peut
importer un service RÉELLEMENT partagé de l'app (le garde SSRF de
`Services/netFetch`) là où le barrel ne suffit pas. Un module externe, jamais ;
côté client, aucun import `@/…` pour personne. S'il manque quelque chose au
SDK, on l'ajoute au SDK.

Un module déclare `@deveye/types` en `peerDependencies` (la seule du template) ;
les modules in-repo y ajoutent `react` et `zod`, résolus depuis l'app.

## Les sentinelles, en trois couches

1. `validateManifest` et les vérifications du générateur (ids, collisions,
   version minimale de `@deveye/types` par `minTypesVersion`, préfixe SQL) : la
   CI du template ET `gen:features`.
2. `gen:features --check` dans le `ci` de l'app : la glue committée ne peut pas
   dériver de la config.
3. Le boot. `registerModules` (`_sdk/register.ts`) refuse : un manifest
   invalide, un id déclaré deux fois, `notify` sans `notifies`, un `shareTier`
   autre que `'never'` sans entrée `items`, un arbre de copie invalide, une spec
   d'environnement mal formée, `manifest.domains` sans `server.domains` (et
   l'inverse), des `server.quotas` qui ne suivent pas le manifest, une commande
   hors `scope: 'account'` dans un module `accountOnly`, des clés de
   `mailSamples` ou d'`e2e` invalides, deux modules qui demandent `signupHint`.
   Puis, sur l'ensemble fusionné : le registre refuse une commande déclarée
   deux fois (module et native), `buildTopicIndex` (`_topics.ts`) exige que le
   préfixe d'un module soit son id et que tout `mutates` nomme un sujet connu,
   `assertAccessDeclared` (`_permissions.ts`) que chaque commande déclare son
   accès. `createModuleServices` refuse deux offreurs du même provider,
   `modulePublicRoutes` une route sans la capacité `'routes.public'` ou montée
   sur `/`, et `assertExportCoverage` (`Services/accountExport/coverage.ts`) une
   table sans sort dans l'export de compte.

## Ce que le SDK offre, et qui s'en sert

Chaque point se lit dans `src/sdk/` de `@deveye/types` (`manifest.ts`,
`server.ts`, `client.ts`, `providers.ts`) et dans au moins un module installé.

### Les hooks de l'agent

`FeatureService.agentHooks` (capacité `'agents'`, réservée aux ids natifs)
reçoit les événements entrants : `onAgentConnect`, `onAgentOffline`, la
télémétrie une fois persistée par l'app et pour les seuls appareils actifs
(`onReport`, `onMetricsBatch`, `onIntegrity`, `onAuthEvents`), et le protocole
de synchronisation (`onSyncChanged`, `onSyncIndex`, `onSyncChunk`, `onSyncAck`,
`onSyncBusy`, `onSyncOpResult`, `onSyncDeviceKey`). `moduleAgentHooks()`
(`_sdk/register.ts`) les agrège pour `src/agent/ws.ts`, qui ne connaît aucun
module ; un hook qui lève est isolé et journalisé, et un service arrêté par la
maintenance n'en reçoit plus. Sentinelle lit les quatre hooks de télémétrie et
décide seule de ce qu'elle surveille ; CloudSync lit ceux de synchronisation.

Dans l'autre sens, la façade `agents` (`ctx.deveye.agents`, `deps.agents`)
porte les ordres sortants, aux noms du hub : les requêtes `requestSync*` et le
fan-out `publishSync*` (CloudSync), `requestScan` et `pushConfig` (Sentinelle),
les ordres de fichiers `requestFilesMutate` / `requestFilesUpload` /
`awaitFilesOp` / `cancelFilesOp` et l'archive tirée par crédits
`archiveFolder` (Sauvegardes), `dockerRun` et `dockerInventory`
(Déploiements), `openTcp` vers la boucle locale de la machine ou un hôte de ses
`tunnel_targets` (Sauvegardes), que les helpers `deviceRelay` du SDK
(`relayDeviceOptions`, `authorizeRelayDevice`, `relayForAuthor`,
`openDeviceTunnel`) emballent en choix d'un appareil, revérification du droit
de son auteur et écouteur local, avec le champ `DeviceRelayField` côté client
(Bases de données, Déploiements), et `disconnectAgent`, `requestDestroy`,
`servedManifest`, `metricIntervals`, `buffered` (Appareils). `ctx.transport` est le socket de
l'appelant (`subscribeSync`, `sendSyncChunk`). La configuration poussée à un
agent est recomposée par l'app (`src/agent/config.ts`), qui demande sa part à
Sentinelle par `SENTINEL_AGENT_CONFIG_PROVIDER`. La garde d'un appareil est
unique, `src/agent/authorize.ts`, et la façade `devices.authorize` l'appelle.

### Les providers, dans les deux sens

Un provider est un contrat nommé (`src/sdk/providers.ts` de `@deveye/types`)
qu'un service offre dans `FeatureService.providers` et que n'importe qui lit à
l'exécution : l'app par `moduleProvider(clé)`, un module par
`ctx.providers.get(clé)` ou `deps.providers.get(clé)`. Le lecteur ne sait pas
qui offre la clé, et dégrade proprement quand personne ne l'offre
(`undefined`) ; une clé n'a qu'un offreur, le boot refuse le second.

L'app lit : `ACCOUNT_PLAN_PROVIDER` (l'offre d'un compte : `Services/quota.ts`,
`features/_planPauses.ts`, `features/user/plan.ts`), `MAIL_TRANSPORT_PROVIDER`
(le transport des alertes e-mail, `Services/notifications.ts`, et la façade
`mail.listAccounts`), `SENTINEL_AGENT_CONFIG_PROVIDER` (`src/agent/config.ts`),
`PROJECTS_USAGE_PROVIDER` (quels projets relient un élément,
`features/sharing/_shared.ts`), `AUDIENCE_SELF_PROVIDER` (le suivi d'usage de
DevEye lui-même, `Services/debug/selfTracking`). Les modules se lisent entre
eux : Projets lit les contrats d'éléments (`UPTIME_ITEMS_PROVIDER`,
`DATABASE_ITEMS_PROVIDER`, `DEPLOY_ITEMS_PROVIDER`, `GIT_ITEMS_PROVIDER`,
`AUDIENCE_ITEMS_PROVIDER`, `HOSTING_ITEMS_PROVIDER`) avant de relier un
élément ; Sauvegardes lit `DATABASE_BACKUP_PROVIDER`,
`MAILSERVER_BACKUP_PROVIDER`, et le contrat d'arborescence commun à
`CLOUDSYNC_BACKUP_PROVIDER` et `HOSTING_BACKUP_PROVIDER` pour ses sources ;
Uptime lit `DEPLOY_ITEMS_PROVIDER`, `GIT_ITEMS_PROVIDER` et
`PROJECTS_USAGE_PROVIDER` pour ses sources de déploiement (`list`,
`authorize`, `activity`, `linkedItems`) ; le module de facturation des
comptes offre `ACCOUNT_PLAN_PROVIDER`.

Côté client, `FeatureClient.providers` est le jumeau : les écrans lisent par
`moduleClientProvider(clé)` (`client/src/sdk/registry.ts`). Les onglets d'un
projet composent ainsi les composants d'Uptime, de Bases de données, de
Déploiements, de Git, d'Audience et d'Hébergement (`*_CLIENT_PROVIDER`), et la
tuile d'appareil de l'accueil vient de `DEVICES_CLIENT_PROVIDER`.

### Les tickets de session

Un module ne voit ni identifiant de session ni clé. Ce qu'il tend au
navigateur hors du fil WebSocket (l'URL d'une pièce jointe, le `state` d'un
retour OAuth, l'envoi d'un fichier) passe par
`ctx.secrecy.ticket(payload, { ttlSeconds })` : un jeton signé par l'hôte
(`signModuleTicket`, `src/auth/jwt.ts`), lié à la session de l'appelant, à
l'espace et au module, deux minutes par défaut. Une route publique du service
le rend par `deps.secrecy.redeem(ticket)` en
`{ userId, workspaceId, payload, cipher: { server, private | null } }` :
l'étage gardé tant que la session est déverrouillée, `null` sinon, et `null`
pour un ticket périmé ou d'un autre module. Mail (pièces jointes, OAuth),
Convertisseur (envoi et récupération d'un fichier), Finances et Hébergement
s'en servent. Le harnais simule les deux bouts
(`createTestContext().secrecy.ticket`,
`createTestServiceDeps().secrecy.redeem`).

### Les routes publiques et `postStream`

Capacité `'routes.public'` : `FeatureService.publicRoutes(app: SdkPublicApp)`
déclare des routes sans session, `get` et `post` avec par route un
`rateLimit`, un `bodyLimit` (le défaut de l'hôte vaut un mégaoctet), `rawBody`
(les octets exacts, pour une signature de webhook) et `exposure`
(`'everywhere'` par défaut ; `'app'` pour ce que seul le navigateur connecté
appelle, un téléchargement à ticket, un retour OAuth). La requête porte
`headers`, `body` décodé, `query`, `params`, `host` (normalisé, jamais une
preuve) et `ip` ; la réponse est chaînable (`header`, `code`, `send`). L'hôte
monte ces routes sur chacun de ses écouteurs (`modulePublicRoutes(app, 'app')`
dans `src/app.ts`, `'public'` dans `src/publicApp.ts`), journal silencieux,
garde de maintenance, et retient leurs chemins pour son délégateur CORS
(`isModulePublicPath`, motifs compris pour un chemin paramétré). La racine `/`
est refusée au boot : elle appartient à l'hôte (voir les domaines). Audience
(la balise), Mail (`exposure: 'app'`), Uptime, Projets, Facturation, Serveur
mail, Finances, Convertisseur, Hébergement, Rendez-vous et le module de
facturation des comptes en déclarent.

Une route qui reçoit un fichier se déclare par
`postStream(path, { maxBytes, exposure: 'app', rateLimit? }, handler)` : le
corps n'est ni décodé ni tamponné, l'hôte le rend en flux (`body.bytes()`,
`body.contentLength`) et coupe la connexion au-delà de `maxBytes`, dans un
contexte Fastify à lui où aucun parseur n'est enregistré. `exposure: 'app'`
est obligatoire et littéral, le chemin n'admet pas de paramètre, la route reste
hors des chemins que le délégateur CORS élargit (un envoi venu d'un autre site
s'arrête au prévol), et s'authentifie par un ticket. Convertisseur
(`features/convert/src/server/routes.ts`) et Hébergement s'en servent.

### Les domaines

Un module qui sert quelque chose sous un nom que l'espace possède déclare
`manifest.domains` (`hint`, `service`, `placeholder?`, `removal?`, `web?`) ET
l'entrée serveur `domains` (`records`, `probe`, `useCount?`, `onRemoved?`) ; le
boot refuse l'un sans l'autre. La coquille rend l'onglet Domaines
([SETTINGS.md](./SETTINGS.md)). La vérification a deux étages. La propriété est
l'affaire du socle : un TXT `_deveye.<hôte>` portant `deveye-<slug>=<jeton>`
(`domainOwnershipRecord`, `src/sdk/domains.ts` de `@deveye/types`), relu par
`Services/domains/engine.ts`. Le service est celle du module : sa `probe` n'est
appelée qu'une fois la propriété acquise, et rend une phrase plutôt que de
lever. Un domaine vérifié ne retombe qu'au troisième échec d'affilée
(`FAILURES_BEFORE_DROP`), à l'un ou l'autre étage. La table est
`feature_domains` (hôte unique par fonctionnalité, tous espaces confondus), la
passe de fond `Services/domains/verifier.ts` (env `DOMAIN_PROBE_TICK_SECONDS`,
`DOMAIN_OK_SECONDS`, `DOMAIN_PENDING_SECONDS`), et les crochets reçoivent un
contexte sans session (`FeatureDomainsContext` : `repo`, `origins`,
`cipherFor`, `storeFor`, `keys`, `dns`, `logger`). `onRemoved` passe avant la
suppression : s'il lève, le domaine reste. Le module lit ses domaines par
`ctx.domains` (`list`, `get`, `verified`, dans l'espace actif) et
`deps.domains` (`findByHost`, `get`, `listVerified`, tous espaces : de quoi
router une requête entrante par son nom d'hôte). Rendez-vous, Serveur mail,
Uptime, Projets, Facturation et Hébergement déclarent des domaines.

Un manifest dont les domaines servent des pages déclare `domains.web: true`
(Uptime, Projets, Facturation, Rendez-vous, Hébergement). Le socle ajoute
alors, entre la propriété et la sonde du module, ses propres contrôles
(`Services/domains/web.ts`) : le nom pointe vers l'origine publique, puis y
répond en HTTPS avec un certificat valable, chacun avec sa phrase. Ces noms
sont ceux que le proxy lit sur `/api/domains/proxy`
(`Services/domains/proxy.ts`, env `DOMAIN_PROXY_TOKEN`,
`DOMAIN_PROXY_UPSTREAM`, `DOMAIN_PROXY_ENTRYPOINT`,
`DOMAIN_PROXY_CERT_RESOLVER`) pour obtenir seul leurs certificats ; un
certificat qui arrive laisse le service `pending`, pas `failed`. Ils se
comptent à la limite d'offre `domains.hosts` ([QUOTAS.md](./QUOTAS.md)), et
`domain.list` rend le mode des certificats (`https`) et cette limite (`quota`).
La sonde du module n'a plus qu'à prouver que c'est cette installation qui
répond : un jeton servi sous `/.well-known/deveye-<slug>` (Facturation :
`features/invoicing/src/server/domains.ts`), et chaque route publique ne sert,
sous un domaine client, que l'espace qui le possède.

La racine d'un domaine client (`GET /`) appartient à l'hôte : aucun module n'y
monte de route. Un service qui veut y répondre, pour un nom qui EST la page
(une page de statut d'Uptime), déclare `domainRoot(req, reply, domain)`
(capacité `'routes.public'` et `domains.web` exigés). `modulePublicRoutes`
monte `GET /` sur les deux écouteurs : un hôte qui n'est pas une origine de
DevEye et qu'un module a VÉRIFIÉ (pas seulement pointé : le proxy reçoit aussi
ceux-là) va au premier module installé qui sert sa racine, derrière la garde de
maintenance ; tout le reste retombe sur le repli de l'écouteur, le client sur
l'app et 404 sur la surface publique. Le module route par le `domain` reçu,
jamais par l'en-tête. Uptime, Projets et Hébergement servent une racine.

L'hôte sert aussi, sur les deux écouteurs et donc sous tout domaine client,
l'icône de DevEye en 64 pixels à `DEVEYE_ICON_PATH` (`/deveye-icon.png`,
`src/assets/deveye-icon.png`) : l'icône d'onglet d'une page publique qui n'en a
pas à elle. Une adresse et non une URL de données, que les aperçus de lien et
les robots savent suivre.

### Les clés dérivées et le scellement

`keys` (`ctx.keys`, `deps.keys`) emballe du matériel de clé possédé par le
module sous la clé serveur, jamais de la donnée utilisateur :
`sealBytes(plain, context)` / `openBytes(sealed, context)` scellent sous une
sous-clé propre au module (`serverKeysOf`, `_sdk/host.ts`), si bien qu'un blob
scellé par un module ne s'ouvre ni dans un autre ni comme une clé de l'app, et
`context` (`<table>:<colonne>:<id>`) lie le blob à sa ligne.
`derive(salt, info, length)` est une HKDF-SHA256 sur la même clé, jamais
stockée : pour ce qui doit survivre à la base (une clé rangée en table
dormirait dans la sauvegarde qu'elle protège). Sauvegardes en dérive la clé de
ses archives, que `scripts/restore-backup.mjs` refait sans DevEye ; Audience le
sel de ses visiteurs ; Finances, Hébergement et OSINT s'en servent aussi.

### Le magasin d'objets

Capacité `'objects'` : `deps.objects(localDir)` rend le magasin de l'hôte
(`Services/objectStorage`), pour les fichiers qu'un module garde pour ses
membres. Sur le disque du serveur sous `localDir`, ou dans le bucket S3 que
l'hôte configure (`STORAGE_S3_*`), toutes les clés d'un module sous
`<préfixe>/<module>/`. Une clé est un chemin relatif, et la base ne garde que
la clé, jamais l'endroit où elle se résout : l'hôte peut déplacer l'arbre
entier sans réécrire une ligne. `put`, `putFile`, `get` (par intervalle),
`head`, `list`, `delete`, `deletePrefix` ; `spoolDir()` reste sur le disque
pour ce qui ne s'écrit pas d'un bloc (un envoi repris) ; `ephemeralRoot()` dit
une racine sur aucun volume monté, que le module refuse en nommant sa variable.
Le conteneur `DEVB` du SDK (`@deveye/types/sdk/server`) scelle ce qui y entre
(`sealStream`) et le relit en entier ou par intervalle (`openSealedStream`,
`openSealedRange`) ; `contentDisposition` et `parseByteRange` servent un
fichier en HTTP. Sauvegardes, CloudSync et Hébergement l'utilisent ; le harnais
offre `memoryObjectStore()`.

### L'export des données d'un compte

`FeatureServer.accountExport` ([ACCOUNT_EXPORT.md](./ACCOUNT_EXPORT.md)) dit le
sort de chaque table possédée : écrite par l'hôte (`SdkExportTable`, avec
`omit` pour les colonnes secrètes), `'custom'` pour les crochets `account` et
`workspace`, ou `{ skip }` avec la phrase que le titulaire lit. `store.omit`
tait les clés secrètes du `FeatureStore`, que l'hôte exporte sinon, et `files`
mesure les parties lourdes pour la popup. La déclaration est confrontée au
schéma réel au boot (`assertExportCoverage`, les tables de l'app dans
`CORE_EXPORT_TABLES`) ; les crochets reçoivent les deux étages du compte pour
la durée de l'export (`cipher(mode)`, `open(blob)`) et un `signal` qui tombe
quand le téléchargement s'arrête. Chaque module installé en déclare un.

### Les variables d'environnement

`FeatureServer.env` est la spec des variables que le module lit
(`defineModuleEnv`, lue par `readModuleEnv` : `int`, `text`, `path`, `url`,
`flag`, `choice`, `secret`). Un module lit ses variables lui-même, jamais par
`Utils/Env`, et chacune a un défaut qui marche. L'hôte relit la même spec au
démarrage (`warnUnsetModuleEnv`, en tête de `main()` dans `index.ts`) et écrit
un avertissement par module qui nomme chaque variable absente ou illisible,
avec la valeur appliquée : un défaut qui devine le monde de l'exploitant
(l'adresse du site, un dossier) se lit au démarrage au lieu de se découvrir en
production. Une variable posée vide compte comme posée ; `optional` fait taire
celles qu'une installation peut ne pas utiliser (clés OAuth, certificat
fourni) ; un secret n'est jamais écrit. Une spec mal formée arrête le
démarrage (`moduleEnvProblem`). Uptime, Sauvegardes, Mail, Appareils,
Sentinelle, Convertisseur, Météo, Finances, Serveur mail et les modules privés
en déclarent.

### Les services externes

`FeatureServer.externalServices({ repo, refresh })` rend les dépendances
externes du module au niveau de l'instance (un fournisseur joint avec la clé de
l'instance, jamais un service qu'un espace règle lui-même) : une carte chacune
(`SdkExternalService` : `state` parmi `ok`, `degraded`, `down`, `inactive`, une
phrase, des faits « clé : valeur », des jauges). La page admin Services
externes les lit par `moduleExternalServices` (`Services/externalServices`),
après les sondes de l'hôte (stockage objet, SMTP, versions de l'agent, proxy
des domaines, page d'état). Appels réseau permis, bornés à 8 s par module ; un
module qui lève, tarde ou rend une forme invalide devient une carte en panne.
La page garde sa mesure 5 minutes, `refresh` la demande à nouveau : un module
garde en cache ce qui coûte (un quota d'API, une liste longue). Météo
(Open-Meteo), Mail (Google, Microsoft), Finances (Enable Banking) et la
facturation des comptes (Stripe) en déclarent.

### Tests et débogage

Pour la page Tests et débogage ([DEBUG.md](./DEBUG.md)) : `mailSamples`, chaque
mail du module construit par son vrai constructeur sur des données d'exemple
(`sender: 'server'` exige `accounts.mail` ; `sender: 'workspace'` passe par une
boîte Mail que l'administrateur choisit), et `e2e`, ses scénarios de bout en
bout (`SdkE2eContext` : `send` par un vrai socket d'un compte jetable, `fetch`
sans session, `waitFor`, `defer`) et le `sweep()` de ce qu'ils laisseraient
hors de ses tables. Clés en `[a-z][a-zA-Z0-9]*`, uniques, vérifiées par
`registerModules`. Facturation, Rendez-vous, Hébergement et le module de
facturation des comptes déclarent des échantillons ; Uptime, Notes, Audience,
CloudSync, Hébergement et la facturation des comptes des scénarios.

Un service peut aussi dire `health()` (`up`, `degraded`, `down`, une raison
lisible par le public) : la page d'état l'interroge par `moduleServiceHealth`
(`Services/statusProbe.ts`), borné à 2 s, jamais sur un service qu'une
maintenance tient à l'arrêt ([STATUS_PAGE.md](./STATUS_PAGE.md)). Serveur mail
et la facturation des comptes le déclarent. `onAccountDeleted(userId)` passe
avant la suppression d'un compte (un abonnement à résilier) et peut rendre une
phrase que le mail de confirmation porte.

### Le partage, les éléments, le déplacement et la copie

`shareTier` dit ce que le chiffrement autorise (`'open'`, `'perItem'`,
`'never'`) ; tout autre que `'never'` engage le module : une entrée `items`
(`homeOf`, `labelOf`), `ctx.sharing.scope()` dans ses listages avec le codec
choisi ligne par ligne (`cipherFor`, `homeOf`, `orderOf`),
`ctx.sharing.setOrder` pour ranger un élément projeté dans l'espace actif, et
`ctx.items.restrictions()` sur ce qu'ils rendent ([SHARING.md](./SHARING.md)).
`ctx.items.assert(itemId, level)` garde une commande qui vise un élément,
`ctx.items.canExtra(itemId, key)` répond pour une permission propre sur CET
élément (Projets, Sauvegardes), `ctx.items.forget(itemId)` fait le ménage d'un
élément supprimé (projections, restrictions, route de notification). Côté app,
`moduleItems` (`register.ts`) est ce que les commandes transversales de partage
et de routage savent des éléments d'un module ; `isModuleShareWired`,
`isModuleMovable` et `isModuleCopyable` disent ce que le module a branché. Un
module externe partage sous les mêmes règles qu'un module in-repo (Hébergement
est `'open'`).

Les trois `'perItem'` (Notes, Mail, Projets) répondent par `items.shareable` :
un élément sous l'étage gardé ne se projette pas, et le refus le dit. `move`
est l'unique opération qui rechiffre (`plan` puis `apply` dans la transaction
de l'app, `resealCells` du SDK) ; son absence est la réponse sûre, pas un
oubli. `copy` décrit l'élément par un arbre (`ItemTree`, `movableCellsOf` pour
tenir une seule liste de cellules) et l'app lit et écrit (`exportItemTree`,
`importItemTree`), vers cet espace ou une autre instance ; `plan` sur la
source, `admit` et `settle` dans la transaction de destination. Uptime,
Audience, Bases de données, Déploiements, Git, Mail, Notes et Projets se
copient.

### Les quotas et les pauses

`manifest.quotas` déclare ce que l'offre d'un compte peut borner (stock, flux
ou par opération, en nombre ou en octets), `server.quotas` dit comment le
compter, `ctx.quota` (`limit`, `assert`, `usage`, `assertActive`, `paid`,
`isPaused`, `paused`) et `deps.quotaFor(workspaceId)` l'appliquent,
`deps.pauses` donne les éléments en pause et `onPlanPause` prévient de ce qui
vient de l'être. Le détail, les règles et les limites du cœur sont dans
[QUOTAS.md](./QUOTAS.md).

### Le direct

`mutates` sur une commande bat le sujet du module (`true`) ou une liste de
sujets : les siens, un secondaire déclaré par `manifest.topics` (la discussion
d'un projet), celui d'une autre feature dont les écrans reflètent la donnée.
`alsoInvalidatedBy` fait relire des clés quand le sujet d'une autre feature bat
(Rendez-vous relit ses types quand un domaine change). Côté service,
`deps.live.changed(workspaceId, topics?)`. La voie de poussée, capacité
`'live.publish'` : `ctx.live.publish` et `deps.live.publish` envoient une trame
nommée sous le préfixe du module aux connexions qui ont `read` sur la feature,
que le client lit par `onServerEvent` (Convertisseur, Mail, Jeu de la vie).
`accountChanged(userId)` fait relire l'offre d'un compte et réappliquer ses
pauses. [LIVE.md](./LIVE.md) dit le reste.

### Les notifications

Capacité `'notify'` (qui exige `notifies: true` et `notifications.hint`) :
`hasRoute(itemId?)`, `send(alert, { itemId | itemIds, except })` (`itemIds`
pour une nouvelle qui concerne plusieurs éléments à la fois, dite une fois :
Déploiements), et le suivi vivant `liveChannels({ itemId })` /
`postLive(channelId, message, messageId?)`, un message riche publié puis
modifié jusqu'à sa conclusion (Déploiements). L'alerte porte `subject`, `body`,
`payload` et des `embeds` Discord facultatifs. Les routes et les canaux sont
ceux que l'espace a réglés pour LA feature
([NOTIFICATIONS.md](./NOTIFICATIONS.md)).

### La flotte, les comptes, les membres

`devices.read` : `devices.authorize(id, { extras })` est LA garde de l'app et
éprouve, avec `extras`, les permissions d'Appareils de l'appelant sur CET
appareil, qu'un module ne peut pas nommer dans son `access` ; `devices.list()`
rend ceux de l'espace et ceux qui y sont projetés ; côté service,
`devicesFor(ws)` et `deps.devices.find(id)`, et `deps.access.feature` /
`deps.access.device` relisent le droit d'un auteur sans session (Sauvegardes).
`telemetry.read` (ids natifs) : `snapshot`, `pinInstant` (Sentinelle).
`workspaces.read` : `workspaces.list()`, tous les espaces, administrateur
global seulement. `members.read` : `members.list()` avec la couleur de chaque
compte (Git, Projets, Sauvegardes, Jeu de la vie). `accounts.read` :
`ctx.deveye.accounts.me()` et, côté service, `deps.accounts` (`find`,
`findByEmail`, `list`, `search`, `all` ; `e2e` dit un compte jetable,
`suspended` un compte suspendu). `accounts.usage` : `usage.of`,
`usage.ofMany`. `accounts.mail` : `deps.accountMail.send(userId, message)`
écrit à l'adresse du compte par l'expéditeur du serveur, `sendToAdmins` à
chaque administrateur actif, `configured` est faux sans SMTP. Le module de
facturation des comptes déclare les trois capacités de compte, Hébergement
`accounts.mail`.

### Le manifest, au-delà des commandes

`topbarWidget` + `TopbarWidget` dans l'entrée client : un mini-widget de la
barre du haut, rendu SANS prop (tout ce qu'il affiche passe par les commandes de
SA feature, autorisées côté serveur) et seulement pour les membres dont le rôle
accorde la feature ; l'hôte l'enveloppe dans un bouton qui ouvre la feature,
rien d'interactif dedans (Appareils, Uptime, Rendez-vous). `accountEntry` ouvre
`AccountView` depuis le menu du compte, `accountOnly` retire carte et ligne de
rôle et impose `access.scope: 'account'` à toutes les commandes (facturation
des comptes) ; `adminEntry` ouvre `AdminView` parmi les pages système, pour
l'administrateur global (Hébergement) ; [QUOTAS.md](./QUOTAS.md) les détaille.
`extraPermissions` (dix au plus) et `access.extras` :
[PERMISSIONS.md](./PERMISSIONS.md). `settings` et `settingsPanels` :
[SETTINGS.md](./SETTINGS.md). `sources` : [SOURCES.md](./SOURCES.md). `links`
(six au plus) dessine les liaisons de la fiche « À propos ». `commandPrefix`
n'existe que pour un id natif dont la casse des commandes diffère de l'id
(CloudSync : `cloudSync.*`). `Art` est la vignette de la carte au marché
d'ajout et sur sa fiche « À propos » : des enfants SVG colorés aux jetons du
thème.

### Le client

`featureApi(manifest)` rend `send(name, input, { timeoutMs, workspaceId })` et
`useResource` typés sur les commandes du module ; `workspaceId` fait exécuter la
commande dans un autre des espaces de l'appelant (`useWorkspaces()`), sous ses
droits là-bas : c'est le navigateur qui porte une donnée d'un espace à l'autre,
comme pour la copie d'un élément ; `commandsApi(commands)` fait de même pour
les commandes de transport `agent.*`. Le chiffrement par mot de passe se lit
par `useSecrecy()`, `ensureSecrecyUnlocked()` et `withSecrecy(run)` (réessaie
une fois après l'invite) ; `humanizeError` traduit les codes, `locked` et
`timeout` compris. `invalidate(clé)` et `useResourceVersion` relient une
mutation aux widgets qui la lisent, `onServerEvent` écoute la voie de poussée,
`openFeature` ouvre une autre feature sur un élément, `useDomains(feature)` lit
les domaines. Le reste du barrel (composants, dialogues,
`FeatureSettingsButton`, `SaveButton`, `ReadOnlyNotice`, `useLiveSegment`,
`DeviceRelayField`...) est décrit par le portrait `client-ambient.d.ts` et la
REFERENCE du template.

### Tests et smoke

`npm run test:features` couvre `features/*/src/**/*.test.ts` sur les harnais de
`@deveye/types/sdk/testing` : `createTestContext` (surcharges `unlocked`,
`itemRestrictions`, `itemExtras`, `shares`, `quotaLimits`, `paid`,
`pausedItems`, `liveChannels`, `devices`, `domains`, `providers`,
`origins`...) enregistre ce que le handler a fait (`recorded`, dont
`liveMessages`) ; `createTestServiceDeps` fait de même pour un service, `redeem`
et verrou compris ; `createTestDomainsContext`, `memoryObjectStore`,
`testDevice`, `testDomain` complètent. Un cipher `'private'` scellé
(`unlocked: false`) lève `locked` comme le vrai.

L'IDE : `features/tsconfig.json` est le projet CLIENT des modules in-repo (étend
celui du client : alias `deveye-sdk-client`, JSX) ; leur part serveur et leurs
contrats sont inclus par le tsconfig racine, et
`features/tsconfig.server.json` les compile en CI
(`npm run typecheck:features`, avec les déclarations ambiantes de `src/types`
qu'un import de privilège atteint). Pas de `references` : elles exigeraient
`composite`.

Le smoke E2E : `npm run smoke:feature -- <id> <label>` démarre un serveur sur
le bundle construit et vérifie ce qu'aucune autre sentinelle ne voit : la
feature au marché d'ajout, la tuile posée, un aller-retour de commande sur le
fil, zéro exception JS. `npm run ci:smoke` (`scripts/smoke-all.ts`) construit
le client dans `.smoke/client`, démarre un serveur à lui (`SMOKE_PORT`, 3999
par défaut), sonde chaque module de `features.config.json` et de
`features.local.json`, et éteint tout.

### L'installation privée

`features.local.json` (gitignorée, entrées par `path`) installe un module hors
de l'image publique. Trois fichiers locaux sont toujours présents, réparés par
`gen:features --ensure-local` (en `prestart` et en tête du `ci`) :
`src/features/_generated/installed.local.ts`,
`client/src/generated/features.local.ts` et
`client/src/Styles/icons.local.css` ; `--check` vérifie les committés et répare
les locaux. La CI publique ne voit jamais un module privé.

## La désinstallation d'un module

Le geste inverse de l'installation, conçu pour emporter TOUTES les traces :
`npm run uninstall:feature -- <package>` (dry-run avec les comptes réels ;
`--yes` pour écrire, serveur arrêté, AVANT de retirer l'entrée de config : le
module doit rester résoluble ; `--id=x-<slug>` pour un module déjà disparu,
dont seule la part app est alors couverte).

- **Côté module** : `src/server/uninstall.sql`, le miroir destructif de ses
  migrations (`DROP TABLE IF EXISTS ft_<slug>_...`, idempotent : un échec au
  milieu se répare en relançant). Sentinelle des deux côtés (`gen:features` ET
  le script) : il ne peut toucher QUE le préfixe du module ; l'allowlist des
  tables antérieures au préfixe (`deveye-feature.json`) ne s'applique pas ici,
  ces tables sont des données de l'app.
- **Côté app**, le script nettoie ce qu'aucun module ne voit : `feature_kv`,
  `feature_domains`, les enregistrements `_migrations` (`<id>/...`),
  `notification_channels` et `notification_routes` (liaisons par cascade),
  `item_shares` et `item_role_grants`, les grants dans le JSON
  `workspace_roles.features` (droit + extras + canaux), et la feature dans
  chaque `workspaces.home_layout` (tuiles, dossiers, mini-widget de topbar). Le
  journal d'audit reste : c'est de l'histoire, pas une dépendance.
- La part pure (nettoyages JSON, sentinelle SQL) vit dans
  `scripts/lib/uninstall.ts`, testée par `npm test`.
- **Conséquence assumée** : les tables en allowlist survivent à la
  désinstallation, même quand elles ne servent qu'au module. C'est le prix de
  la règle « un module ne détruit jamais une table du schéma public » ; les
  retirer vraiment demande une migration du socle.

## Ce que le contexte serveur expose, en une liste

Par requête (`SdkFeatureContext`, construit dans `_sdk/context.ts`) :

- l'identité de l'appel : `userId`, `workspaceId`, `workspace`, `isOwner`,
  `isAdmin`, `canWrite`, `canExtra(key)` et `extraValue(key)` (par
  `resolveExtras`, la même règle que le harnais). Une commande qui exige
  l'administrateur global le déclare par `access: { admin: true }`, une qui agit
  sur le compte plutôt que sur un espace par `access: { scope: 'account' }` ;
  le dispatcheur applique les deux ;
- `repo`, `store` (magasin clé-valeur chiffrable,
  `'server' | 'private' | 'none'`), `cipher(mode)` ;
- `deveye`, la façade gardée par `nativeCapabilities` : `notify` (`hasRoute`,
  `send`, `liveChannels`, `postLive`), `mail.listAccounts`, `members.list`,
  `devices` (`authorize`, `list`, `isOnline`), `workspaces.list`,
  `accounts.me`, `usage` (`of`, `ofMany`), `telemetry` (`snapshot`,
  `pinInstant`), `agents` (la façade de la flotte, décrite plus haut) ;
- `transport` (le socket appelant, `agents`) ;
- `live.publish(event, payload)` (capacité `live.publish`) et
  `live.accountChanged(userId)` ;
- `secrecy.isUnlocked()` et `secrecy.ticket(payload, { ttlSeconds })` ;
- `items` (`restrictions`, `assert`, `canExtra`, `forget`) ;
- `quota` (`limit`, `assert`, `usage`, `assertActive`, `paid`, `isPaused`,
  `paused`) ;
- `sharing` (`scope`, `setOrder` ; refusé sous `shareTier: 'never'`) ;
- `domains` (`list`, `get`, `verified` ; refusé sans `domains` au manifest) ;
- `providers.get(key)` ;
- `keys` (`sealBytes`, `openBytes`, `derive`) ;
- `audit`, `logger`, `requestId`, `origins { app, public, site }` (où vit
  DevEye, sans barre finale : l'origine des membres, celle de l'écouteur
  public, et le site vitrine où vivent les pages légales, `null` sans site).

Une erreur se signale par `FeatureError(code, message, details?)` ;
`logFailure(logger, userSide, fields, msg)` journalise un échec au niveau que
sa cause appelle (`info` tagué `cause: 'user'` quand le côté de l'utilisateur
l'explique).

Par service (`FeatureServiceDeps`, `_sdk/service.ts`) :

- `repo`, `listWorkspaceIds()`, `storeFor(ws)`, `cipherFor(ws)` (étage ouvert
  seul), `deveyeFor(ws)` (`notify`), `devicesFor(ws)`, `membersFor(ws)` ;
- `devices` (`find`, `isOnline`), `telemetry`, `agents`, `accounts`, `usage`,
  `accountMail`, `domains` (`findByHost`, `get`, `listVerified`) ;
- `access.feature(ws, userId, { level, extras, itemId })` et
  `access.device(ws, userId, deviceId, extras)` : un verdict `{ ok }` ou
  `{ ok: false, reason }`, relu à chaque appel ;
- `quotaFor(ws)`, `pauses` (`isPaused`, `paused`) ;
- `live.changed(ws, topics?)`, `live.publish(ws, event, payload)`,
  `live.accountChanged(userId)` ;
- `keys`, `objects(localDir)`, `secrecy.redeem(ticket)`, `origins`,
  `providers` ;
- `audit` (source système, `userId` facultatif), `createTicker({ intervalMs,
tick })` (boucle avec garde de réentrance, `stop()` attend le tick en cours),
  `logger`.

Par entrée serveur (`FeatureServer`) : `createRepo`, `features`,
`migrationsDir`, `createService`, `items` (`homeOf`, `labelOf`, `shareable?`,
`move?`, `copy?`), `domains`, `accountExport`, `quotas`, `env`,
`externalServices`, `mailSamples`, `e2e`.

Par service créé (`FeatureService`) : `start`, `stop`, `agentHooks`,
`providers`, `publicRoutes`, `domainRoot`, `onPlanPause`, `onAccountDeleted`,
`health`.

Par entrée client (`FeatureClient`) : `Widget`, `Full`, `AccountView`,
`AdminView`, `Art`, `settingsPanels`, `TopbarWidget`, `cacheDurationMinutes`,
`preload`, `holdSecrecy`, `providers`.
