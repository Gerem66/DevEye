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

1. **`deveye-types/sdk`** (publié) : le contrat. Ids `x-<slug>`
   (surensemble pur des enums natifs : rien d'existant n'a été migré),
   `FeatureManifest` + `validateManifest`, le contexte serveur
   (`SdkFeatureContext`, `FeatureStore`, façade), les contrats client
   (`FeatureClient`), le harnais de test. **C'est la surface publique** :
   elle se versionne, elle ne casse plus.
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

Est stable : tout ce qu'exportent `deveye-types/sdk*` et le barrel
`deveye-sdk-client`. Tout le reste est interne et peut bouger. Élargir la
surface = l'ajouter à l'un de ces deux endroits, mettre à jour la déclaration
`types/deveye-sdk-client.d.ts` du template et sa doc REFERENCE. Jamais
d'export « en douce » par un autre chemin.

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

## Dettes connues

- **Publication deveye-types 0.15.0** : le SDK est sur `main` du repo de types
  mais pas publié ; le miroir `node_modules` est à niveau (version 0.15.0
  locale). La CI GitHub du template ne passera qu'après publication.
- **Partage inter-espaces** : `shareTier` externe figé à `'never'`. Brancher
  un module exigerait, dans l'ordre : une migration élargissant
  `item_shares.feature` (VARCHAR(24), or un id externe monte à 27), un point
  d'entrée « domicile d'un élément » côté serveur du module, une façade de
  portée de partage dans le contexte (`foreignIds` pour le listage,
  `cipherFor` par ligne), et l'élargissement des contrats `share.*` à
  `featureIdSchema`. La migration impose son dry-run sur copie du dump.
