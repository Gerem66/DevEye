# Appareils : architecture et invariants

Supervision des appareils (agent Rust → serveur Fastify → client React). Ce
document décrit le **modèle de collecte**, la **carte** du code et les
**décisions de conception à ne pas casser** lors des évolutions.

## La coupure : infrastructure de l'app, feature en module

Deux préfixes de commandes, et c'est la frontière :

- **`agent.*`, le transport, dans l'app.** Vingt-six relais du `MonitorHub` vers
  l'agent d'un appareil : contrats `features/agent.ts` de `@deveye/types`,
  handlers dans `src/features/agent/`, accessibles à tout membre sous le droit
  `devices` et la permission supplémentaire de leur famille :

    | Famille                                                                                         | Accès                                            |
    | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
    | `agent.subscribe`, `unsubscribe`, `collect`                                                     | `devices` en lecture                             |
    | `agent.termOpen`, `termInput`, `termResize`, `termClose`                                        | permission « Terminal distant »                  |
    | `agent.filesList`, `filesAnalyze`, `filesSearch`, `filesMutate`, `filesDownload`, `filesUpload` | permission « Explorateur de fichiers »           |
    | `agent.logSources`, `logQuery`                                                                  | permission « Journaux de l’appareil »            |
    | `agent.dockerInventory`, `dockerStats`, `dockerAction`                                          | permission « Conteneurs Docker »                 |
    | `agent.power`, `listPackages`, `upgradePackages`                                                | permission « Commandes et mises à jour système » |
    | `agent.lifecycle`                                                                               | `devices` en écriture                            |
    | `agent.setAutostart`, `elevate`, `dropPrivileges`, `update`                                     | administrateur global                            |

    Avec eux, tout ce qui écrit les tables **hors session** : le hub
    (`src/agent/hub.ts`, état de processus, vivacité des agents), la socket
    agent et son authentification (`src/agent/ws.ts`, `src/agent/deviceAuth.ts`),
    les trames reçues de l'agent (`src/agent/handlers/`), l'ingestion de la
    télémétrie et la présence (`src/agent/presence.ts`), l'enrôlement
    (`POST /api/agent/enroll`, route publique), la distribution des binaires et
    des scripts d'installation (`src/agent/routes.ts`, `src/agent/installers.ts`,
    `src/agent/source.ts`, `src/agent/sync.ts`), la composition de
    `agent.config` (`src/agent/config.ts`, `src/agent/cadence.ts`), la signature
    des ordres (`src/agent/orders.ts`), les tunnels (`src/agent/tunnels.ts`) et
    **la garde unique** `authorizeDevice` (`src/agent/authorize.ts`).

- **`devices.*`, la feature, module `features/devices`.** Vingt et une
  commandes : la flotte de l'espace (liste, approbation d'un réappairage,
  révocation, renommage, rangement, configuration de collecte, suppression),
  l'historique stocké (métriques, présence, processus, disponibilité,
  instantanés, épinglage, stockage) et les **codes de liaison**
  (`devices.linkCodeCreate` / `linkCodeList` / `linkCodeRevoke`), des
  commandes de socket comme les autres (seule leur _consommation_,
  l'enrôlement, reste en HTTP : elle est publique). La rétention est un
  service du module.

Le module parle au hub par la façade `agents` du SDK : `disconnectAgent`
(révocation, suppression forcée, mise en pause par l'offre), `requestDestroy`
(suppression gérée), `pushConfig` (cadence ou capture changée ; l'app recompose
la config entière, part des modules comprise) et `servedManifest` (le manifest
des binaires servis, pour signaler un agent à mettre à jour). Il atteint un
appareil par `ctx.deveye.devices.authorize` (la garde de
`src/agent/authorize.ts` : le domicile de l'appareil, ou une projection vers
l'espace actif) et la liste de l'espace par `ctx.deveye.devices.list`. Tout ce
qui appaire, range, règle ou efface déclare `access: { level: 'write' }`, doublé
de `ctx.items.assert` sur la ligne visée et, pour ce qui gère la fiche, de son
domicile (`loadHomeDevice` : un espace où l'appareil n'est que projeté le lit
sans le gérer) ; le reste se lit sous le droit `devices`. Aucune commande
`devices.*` n'exige l'administrateur global ; quatre commandes `agent.*` le font
(démarrage automatique, élévation, rétrogradation, mise à jour).

**Tables partagées, assumé.** Les cinq tables (`devices`, `device_link_codes`,
`device_metrics`, `device_process_samples`, `device_presence`) datent du socle
(allowlist de `deveye-feature.json`) : l'infrastructure les écrit par ses dépôts
(`src/db/repos/{devices,metrics,presence,processSamples}.ts`), le module lit et
écrit ce qui relève de la flotte et de l'historique par **son** dépôt
(`src/server/repo/`, un fichier par table). Rien n'y est chiffré : le moteur de
sécurité et l'ingestion doivent lire sans session. Une colonne, un index se
changent par une migration du socle ; le module n'a pas de `migrationsDir`, une
table qui lui serait propre inaugurerait `src/server/migrations/` avec le
préfixe `ft_devices_`.

### Carte du module `features/devices`

```
deveye-feature.json         id, les cinq tables allowlistées, minTypesVersion
src/contracts/commands.ts   les 21 commandes devices.* : la flotte, l'historique, les
                            codes de liaison
src/manifest.ts             nativeCapabilities: agents, devices.read ; resources: devices.list ;
                            quotas: agents (stock) ; settings.item: collect, terminal ;
                            topbarWidget (appareils en ligne) ; six extraPermissions
                            (terminal, files, logs, docker, network, system)
src/server/index.ts         serverEntry : createRepo, features, createService (rétention,
                            onPlanPause), quotas.agents, items (homeOf, labelOf, move),
                            accountExport
src/server/env.ts           MONITORING_RETENTION_DAYS, LINK_CODE_TTL_SECONDS
src/server/_shared.ts       loadDevice (garde + restriction + ligne entière),
                            loadHomeDevice (en plus, le domicile), toDevice /
                            rowToDevice, computeAgentUpdate, parseDeviceReport, l'accès WRITE
src/server/handlers.ts      l'agrégat des trois fichiers suivants, dans l'ordre des contrats
src/server/fleet.ts         les 10 commandes de flotte
src/server/history.ts       les 8 commandes d'historique
src/server/linkCodes.ts     les 3 commandes de codes de liaison
src/server/service.ts       RetentionSweep : le balayage horaire, sur un ticker du SDK
src/server/move.ts          le changement d'espace d'un appareil (rien à resceller)
src/server/accountExport.ts l'export de compte : les listes de processus décompressées
src/server/repo/            index, devices, linkCodes, metrics, presence, processSamples
src/server/*.test.ts        handlers, service, accountExport, repo/processSamples, sur le
                            harnais du SDK
```

Le client, `src/client/` :

```
index.tsx                   clientEntry : Widget, Full, settingsPanels (collect, terminal),
                            TopbarWidget, providers (DEVICES_CLIENT_PROVIDER)
api.ts                      featureApi(manifest) pour devices.*, commandsApi(agentCommands)
                            pour agent.*
store.ts                    la liste des appareils de l'espace, ravivée par le sujet devices
Devices.tsx                 la vue : la barre (aide, appairage) au-dessus de la liste
Monitoring.tsx              la tuile, la liste des appareils et la sélection
MonitoringPanel.tsx         le panneau de l'appareil consulté, à droite de la liste
ConfigPanel.tsx             l'onglet Collecte d'un appareil : cadence, capture, rétention
TerminalSettings.tsx        l'onglet Terminal d'un appareil : compte d'ouverture, fin de session
SettingsPanel.tsx           les deux panneaux SettingsPanelProps de l'appareil
TopbarWidget.tsx            le compteur d'appareils en ligne
TerminalPanel.tsx, FilesPanel.tsx, LogsPanel.tsx, PackagesPanel.tsx, PowerMenu.tsx,
DockerPanel.tsx             le transport agent.* et onServerEvent
DeviceWidget.tsx            la tuile d'un appareil (DeviceWidget du provider), avec
                            DeviceWidget.module.css
policy.ts                   les interrupteurs de [policy] de l'agent : libellés, options --deny
deviceUsage.ts, agentUpdates.ts, agentVersion.ts, useAgentUpdate.tsx,
utils.ts                    les stores et utilitaires du client
availability.ts             pourquoi une entrée du menu est inerte, et dans quel ordre
AgentPanel.tsx              la popup « Agent » : état de l'agent, démarrage auto,
                            privilèges, mise à jour, redémarrage, interruption,
                            approbation d'un réappairage, révocation
Connections.tsx, DeviceActionsMenu.tsx, GraphDetail.tsx, HardwareInfo.tsx, MiniGraph.tsx,
MonitoringInfo.tsx, MonthPicker.tsx, OpenPorts.tsx, PrivilegeInfo.tsx, Timeline.tsx, ports.ts
                            les composants du panneau
style.module.css
manage/useLinkCodes.tsx     les trois devices.linkCode*
manage/LinkCodesDialog.tsx, manage/LinkInfo.tsx
                            l'appairage : émettre un code, et comment s'en servir
manage/installCommand.ts    les commandes à copier (install.sh, install.ps1, link), avec
                            les droits choisis en options de link ; installCommand.test.ts
manage/useDeviceActions.tsx, manage/lifecycleActions.ts, manage/DeviceDialogs.tsx
                            le cycle de vie d'un appareil, les entrées de fiche du
                            menu « Fonctions » (renommer, supprimer, effacer) et
                            les dialogues de confirmation
manage/DownloadAgent.tsx    la distribution des binaires, sur /api/agent/* en HTTP
manage/format.ts, manage/style.module.css
```

Le client offre à l'app `DEVICES_CLIENT_PROVIDER` (`useDevices`,
`refreshDevices`, `resetDevices`, `DeviceWidget`), que l'accueil compose pour
ses tuiles ; une tuile d'appareil ouvre cette vue posée sur lui (segment de
présence `l1`), et l'app ne connaît aucun écran d'appareil en propre. Tout se
règle à l'échelle d'un appareil, dans la coquille commune : `collect` (cadence,
capture, rétention) et `terminal` (compte d'ouverture, sort de la session). La
fonctionnalité elle-même n'a aucun réglage, donc aucun bouton.

## Modèle à cadence unique (+ report + presence)

Toute la collecte est **réglable par appareil** et **poussée par le serveur** à
l'agent (`agent.config`) à la connexion **et** à chaque changement.

Un tick = **un instant** : métriques _et_ processus, sous un seul `ts`, dans un
seul message (`metrics.batch`). Un point de graphe ne peut donc jamais exister
sans les processus qui l'expliquent.

| Flux         | Cadence (défaut)                        | Contenu                                                                                                                                                                                | Stockage                                    |
| ------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Collecte** | 60 s (offre payante) / 300 s (gratuite) | CPU/RAM/disque/réseau/charge/temp/GPU/batterie/users/connexions + `process_count` + E/S disque + **liste des processus** (`all`/`top`/`off`). Chaque point est cliquable sur la frise. | `device_metrics` + `device_process_samples` |
| **Report**   | 1 h (+ connexion)                       | OS + posture sécurité + par-disque (`disks[]`) + ports en écoute + connexions. Dernier état seulement.                                                                                 | `devices.report_json`                       |
| **Presence** | sur transition                          | online/offline de l'agent (frise de disponibilité).                                                                                                                                    | `device_presence`                           |

Défauts serveur dans `@deveye/types` (`domain/device.ts`) :
`DEFAULT_METRIC_INTERVAL_SECONDS = { paid: 60, free: 300 }`,
`DEFAULT_PROCESS_CAPTURE = 'all'`, `DEFAULT_RETENTION_DAYS = 30`. Source unique,
lue par le serveur _et_ par le panneau de configuration. Une cadence laissée au
défaut suit l'offre du propriétaire de l'espace d'origine de l'appareil
(`src/agent/cadence.ts`) ; sans module de facturation, aucune offre n'est payante
et le défaut est 300 s.

Rétention : **une seule durée**, `devices.retention_days` (défaut serveur
`MONITORING_RETENTION_DAYS`, 30 j, lue par le module dans son `env.ts`), qui
régit les métriques, la présence **et** les processus. Un relevé est un
_instant_ : les faire expirer séparément produirait des instants à moitié
lisibles. Balayée chaque heure par le service du module
(`features/devices/src/server/service.ts`, un passage au démarrage puis un
ticker du SDK) ; les instants épinglés y échappent, les appareils archivés
sont figés.

### Une seule énumération par tick

Le coût du tick vient de deux sondes, partagées par tous les signaux :

- **le balayage des processus** (`report::scan_processes`) → liste des
  processus, `process_count`, et sur Linux les E/S par process via
  `/proc/<pid>/io`. Linux lit `/proc` directement (`ps` en repli), macOS passe
  par `ps`, Windows par `sysinfo` ; pid, threads, compte et ancienneté viennent
  de la même lecture.
- **`ss -tuanpH`** (`sockets::read_sockets`) → ports en écoute, connexions
  établies, `activeConnections` **et** connexions entrantes/sortantes par
  process, en un seul appel (`netstat` et `lsof` sur macOS, `netstat -ano` sur
  Windows).

Mesuré sur une machine à 700 processus : **~40 ms par tick**.

### Stockage des processus

Une ligne par instant, la liste étant un **blob JSON gzip** (`payload`), et non
une ligne par processus. C'est sûr parce qu'**aucune requête n'agrège les
processus par nom à travers le temps** : `nearest`, `snapshotTimes`, `storage`,
`deleteRange`, `setInstantsPinned`, `pruneByRetention` travaillent toutes sur
`ts`.

Au-delà de deux jours, le balayage horaire réduit une liste complète à ses 20
premières lignes (`thinBefore`, `kind` passe à `top`), les instants épinglés
exceptés : l'agent classe sa liste par CPU + part de mémoire, donc ce sont les 20
qu'il aurait envoyés en capture « top ».

## Invariants / points forts à préserver

Ces choix sont volontaires ; les conserver garde la feature **stable et
maintenable**.

1. **Une seule source de vérité pour la config, poussée à l'agent.** La config
   vit en base (colonnes `devices.*`), est exposée via `devices.setConfig`
   (bornée par zod), et **rejouée à la reconnexion** : un agent hors ligne au
   moment du changement applique quand même les bons réglages dès son retour
   (l'agent attend la config jusqu'à 2 s avant son premier instant, dans
   `runner.rs`). → Ne pas dupliquer la config côté agent ; ne pas l'appliquer
   uniquement « à chaud ».

2. **`null` = inconnu, jamais « pas encore mesuré ».** Toutes les lignes
   métriques ont la même forme : un champ `null` signifie que la sonde est
   indisponible (pas de capteur, pas les droits, plateforme sans l'API), pas
   qu'on est entre deux cycles. `SPARSE_FIELDS` (dans `MonitoringPanel.tsx` du
   module) ne garde donc que les sondes réellement optionnelles (GPU,
   température, charge, batterie, E/S disque). → Un nouveau champ best-effort
   doit être `nullable` ; ne l'ajouter à `SPARSE_FIELDS` que s'il est
   _intermittent_.

    Corollaire côté types : `metricSnapshotSchema` (ce que l'agent envoie) porte
    `processes`, `metricSeriesPointSchema` (ce que `devices.metrics` relit) ne les
    porte pas : une fenêtre de graphe contient des centaines de points et
    trimballer chaque liste coûterait des mégaoctets pour rien.

3. **Downsample : moyenne pour les jauges, max pour les compteurs.** Le `SELECT`
   bucketisé (`(FLOOR(ts/?)*?) AS ts`) et le `GROUP BY` utilisent **la même
   expression** (sinon `only_full_group_by`). Les colonnes entières repassent par
   `intNum()` (l'`AVG()` produit des décimaux qui violeraient `.int()`). Les
   compteurs cumulés (`net*`, `disk_*_bytes`, `uptime`) prennent `MAX`, le débit
   est dérivé côté client. → Respecter ce partage moyenne/max pour toute nouvelle
   colonne, dans le dépôt du module (`repo/metrics.ts`) comme dans celui du
   socle.

4. **Bucketisation par jour locale en math entière.** `availableDaySummaries` calcule le
   jour local via `FLOOR((ts - tzOffsetMs)/86400000)` (offset = client
   `getTimezoneOffset()`), **indépendamment du fuseau MySQL/Node**. Le calendrier
   désactive les jours futurs. → Pas de dépendance au `time_zone` de session SQL.

    Corollaire : le résumé se lit en **deux requêtes** (tous les instants, puis
    les seuls épinglés) fusionnées en mémoire, et non en un `SUM(pinned)`. Chacune
    est alors couverte par un index (`uq_metrics_device_ts` et
    `idx_metrics_device_pinned_ts`), donc `Using index` sans lecture de ligne ;
    l'agrégat, lui, forcerait un accès par instant. Et **aucune borne
    temporelle** : un plancher à la rétention effacerait du calendrier les
    journées ne contenant plus que des épingles, précisément celles qu'on cherche
    sur la durée.

5. **Dédup multi-disque par `(total, available)`.** APFS/LVM exposent plusieurs
   volumes d'un même conteneur (mêmes tailles) ; on les compte une fois, en
   gardant le mount le plus représentatif (`/` puis le plus court), pseudo-FS
   exclus. Graphes/KPI = **totaux agrégés** ; détail par disque via `report.disks`
   (au clic). → Garder l'agrégat pour les séries, le détail dans le report.

6. **Sondes best-effort = `null`, jamais une fausse valeur.** Sécurité, temp,
   GPU, E/S disque, batterie : indisponible ⇒ `null` ⇒ l'UI masque (pas de 0
   trompeur, pas de courbe plate). → Ne jamais substituer `0` à un « inconnu ».

7. **Tickers à premier tick décalé.** `new_ticker` part à `now + period`
   (`MissedTickBehavior::Skip`) : l'échantillon de connexion est déjà envoyé, on
   évite le doublon immédiat. Un changement d'intervalle **recrée** le ticker. →
   Ne pas revenir à un `interval` à tick immédiat.

8. **Persistance gardée par le statut.** Métriques et processus ne sont stockés
   que pour les appareils `active` (gate dans `agent/ws.ts`). → Tout nouveau flux
   persistant doit appliquer le même garde.

9. **Une seule garde d'accès à un appareil.** `authorizeDevice`
   (`src/agent/authorize.ts`) répond à « de quel appareil parle-t-on, et
   m'est-il visible ? » : la ligne habite l'espace actif, ou y est projetée
   (`item_shares`). Sans dérogation, l'administrateur global compris. Le
   transport l'appelle directement, le module par
   `ctx.deveye.devices.authorize`, la façade du SDK pour les autres modules. Le
   **niveau** exigé (`read`, `write`) est déclaré par chaque commande dans son
   `access`, appliqué par le dispatcheur avant le handler, et la restriction
   par élément se pose par `ctx.items.assert`. → Ne jamais refaire la règle ailleurs, ni
   décider d'un niveau dans un handler.

10. **Frise : clic = instant, glissé = plage.** Distinction par seuil
    (`CLICK_SLOP_PX`) ; le clic s'aligne sur le repère le plus proche. Le `focus`
    (`live`/`range`/`snapshot`) pilote **fenêtre des graphes, résolution, KPI et
    processus** de façon unifiée. → Garder le `focus` comme pilote unique (pas
    d'états parallèles).

    Chaque point étant un instant complet, les repères vont jusqu'à 1 440 par
    jour à 60 s : au-delà de `MAX_INDIVIDUAL_MARKS` la frise dessine des
    **bandes continues** au lieu de traits (les instants épinglés restent
    visibles individuellement). → Ne pas revenir à un rendu un-div-par-repère.

11. **Ports : une bulle = un port joignable de la même façon.** L'agent renvoie
    une entrée **par adresse de bind** (correct : un service dual-stack écoute
    vraiment sur `0.0.0.0` _et_ `::`). C'est l'UI qui fusionne, par
    `(port, joignabilité, interface)`, en unissant protocoles et familles IP
    (`ports.ts` du client du module). → Ne pas dédupliquer côté agent sur autre
    chose que des lignes strictement identiques : l'adresse porte l'information
    d'exposition.

12. **La liste de l'espace vient de la façade, les lignes du module.**
    `devices.list` en portée `workspace` demande à `ctx.deveye.devices.list`
    _quels_ appareils l'espace voit et dans quel ordre : les siens et ceux qui y
    sont projetés, rangés selon le rang propre à cet espace
    (`devices.sort_order` chez lui, `item_shares.sort_order` pour une fenêtre),
    la date départageant. → Ne pas réécrire la règle de visibilité dans le
    module : elle est celle de la garde.

## Cycle de vie d'un appareil & suppression

Statuts (`devices.status`) : `pending`, `active`, `pending_deletion`,
`archived`.

- **Appairage** : qui tient `devices: write` émet un code
  (`devices.linkCodeCreate`, toujours pour l'espace actif, sept jours au plus,
  pour 1 à 1000 machines), l'agent le présente à `POST /api/agent/enroll`. La
  route relit le code sans en dépenser d'usage (verrouillage de l'adresse sur
  les échecs, émetteur qui gère toujours les appareils de l'espace), puis :
    - **empreinte inconnue de l'espace** : l'offre du propriétaire doit
      admettre un appareil de plus (sinon `403 quota_exceeded`, le code reste
      valable), l'appareil est créé `active`, l'agent se connecte aussitôt.
      Des enrôlements simultanés passent tous cette vérification : la passe
      des pauses (`schedulePlanReconcile`) tient les surnuméraires ;
    - **empreinte connue** (réappairage), avec un code à usage unique : la
      fiche existante est reprise, son ancien jeton tombe, sa session ouverte
      est coupée (`hub.disconnectAgent`), et l'appareil passe `pending`.
      L'empreinte est déclarée par l'appelant : sans approbation, un code
      suffirait à saisir une machine et ses partages ;
    - **empreinte connue avec un code à plusieurs usages** : `409 conflict`,
      sans rien dépenser. Deux clones d'une même image ne se volent pas leur
      fiche en silence (`--shuffle-id` côté agent).
      L'usage dépensé, la fiche et le jeton s'écrivent dans une transaction ;
      `devices` est diffusé à l'espace.
- **En attente** : la socket refuse l'agent avec le code `4001`
  (`AGENT_CLOSE_PENDING_APPROVAL`), qui lui dit de réessayer toutes les 30 s.
  Ni config, ni hooks de modules, ni ordres, ni binaire d'auto-mise à jour. Un
  appareil en attente ne compte pas dans l'offre (seuls les `active` font le
  stock du quota).
- **Approbation** (`devices.confirm`, bouton du bandeau d'attente ou popup
  « Agent ») : un appareil `pending` seulement, dans la limite de l'offre. Il
  passe `active`, son agent est admis à la tentative suivante.
- **Révocation** (`devices.revoke`, popup « Agent ») : unilatérale et
  immédiate. L'appareil est archivé (jeton effacé), la session coupée
  (`agents.disconnectAgent`). Seul un nouvel appairage le fait revenir, en
  attente. L'agent reste installé sur la machine.
- **Suppression gérée** (`devices.requestDelete`, menu « Fonctions ») : passe
  en `pending_deletion` en mémorisant le statut précédent
  (`status_before_delete`).
    - Agent **en ligne** → ordre `agent.destroy` immédiat (`agents.requestDestroy`).
    - Agent **hors ligne** → l'ordre part à sa prochaine connexion (`agent/ws.ts`).
    - L'agent **s'auto-détruit** (`commands::handle_destroy` : son dossier de
      config, son binaire, son service de démarrage automatique et son icône,
      voir le README de l'agent) puis répond `agent.destroyed{ok}`. Le serveur
      **archive** alors l'appareil (`archive` du dépôt : statut `archived`,
      `token_hash=''`).
    - En cas d'échec (`ok:false`) : `failDeletion` restaure le statut précédent et
      stocke `delete_error` (affiché sur la fiche). La suppression est **interrompue**.
    - Annulable (`devices.cancelDelete`) tant que l'agent ne s'est pas reconnecté.
- **Archive** : l'appareil n'est plus gérable mais reste **consultable
  en lecture seule** (voyage temporel), rangé dans le groupe « Archivés » de la
  liste. Ses données sont **figées** (les balayages de rétention **excluent**
  `status='archived'`). Pas de config, pas d'approbation. L'agent est refusé
  (`1008`) jusqu'à un nouvel appairage. `devices.forceDelete` archive sans
  attendre l'auto-destruction (agent disparu), en coupant la session.
- **Purge dure** (`devices.delete`, « Effacer l'appareil et son historique »
  sur un archivé) : supprime la ligne + tout l'historique (cascade FK), pour
  tous les espaces ; ne déclenche **pas** d'auto-destruction.
- **Domicile** : tout ce qui gère la fiche (approuver, révoquer, renommer,
  régler, supprimer, effacer l'historique) passe par `loadHomeDevice`. Un
  espace où l'appareil est projeté le lit et pilote son agent selon ses
  permissions, sans le gérer.
- **Changement d'espace** (`src/server/move.ts`, par l'entrée `items.move` du
  SDK) : la ligne change de domicile, relevés, présence et constats la suivent
  par son identifiant ; rien à resceller, rien à réappairer (l'agent
  s'authentifie par son jeton, l'espace ne se lit qu'à l'affichage). Deux
  appareils de même empreinte dans un espace seraient le même vu deux fois : la
  collision est refusée avant d'écrire.

### La fiche, côté client

- **« Fonctions »** : Matériel, explorateur, terminal, logs, conteneurs,
  commandes système, mises à jour système, **Agent**, puis la fiche (renommer,
  supprimer, ou effacer un archivé). Rien n'est masqué : une entrée inerte
  porte son motif (`availability.ts`).
- **« Matériel »** : l'inventaire seul. Les interfaces virtuelles et la boucle
  locale sont repliées derrière un bouton quand des interfaces physiques
  existent.
- **« Mises à jour système »** (`PackagesPanel.tsx`) : le total, puis un
  tableau sans en-tête des outils que DevEye pilote, système puis
  applications, avec leur compte et une case à cocher. Ceux qu'il reconnaît
  sans les piloter (rpm-ostree, fwupd, nix…) restent repliés sous un bouton
  « Autres ». L'agent répond en deux temps : les outils présents aussitôt
  (une vérification de fichiers, `pkg.listResult`), puis le compte de chacun à
  mesure que sa sonde finit (`pkg.count`), et une ligne tourne tant que le
  sien n'est pas arrivé. Tout est coché d'office, on décoche ce qu'on veut
  garder ; le bouton sous le tableau enchaîne les cochés un à un dans l'ordre
  du tableau, tant que la fenêtre reste ouverte. Le compte Flatpak vient du
  plan de `flatpak update` lui-même, installation par installation :
  `remote-ls --updates` compare des identifiants de commit qu'un dépôt OCI ne
  fait pas correspondre.
- **« Agent »** (`AgentPanel.tsx`) : l'état (version, compte, privilèges,
  service, démarrage automatique, transport, politique locale), le démarrage
  automatique, armé ou désarmé quels que soient les privilèges, l'élévation en
  service système ou la rétrogradation, la mise à jour, le redémarrage,
  l'interruption, l'approbation d'un réappairage et la révocation. Démarrage
  auto, élévation, rétrogradation et mise à jour relèvent de l'administrateur
  global (`access.admin` des commandes `agent.*`) ; l'entrée le dit. Approuver,
  révoquer et effacer passent par le dialogue de confirmation commun, qui dit
  en deux phrases ce que fait le geste.

### Invariants de sécurité à préserver

- **Furtivité** (`agent/ws.ts`) : tout échec d'auth/autorisation (jeton absent /
  invalide, appareil inconnu, archivé, empreinte de jeton fausse) **se ferme
  exactement de la même façon** (`close(1008)`, sans raison). De l'extérieur,
  impossible de distinguer ces cas : c'est voulu (anti-énumération). Seul un
  jeton valide d'un appareil `pending` reçoit `4001` ; son porteur connaissait
  déjà ce statut par la réponse d'enrôlement. Seul `active` est admis ;
  `pending_deletion` l'est juste le temps de recevoir l'ordre
  d'auto-destruction.
- **Reprise** (`agent/runner.rs`) : une fermeture `1008` au handshake (avant la
  config) = `SessionOutcome::Rejected`, nouvelle tentative de 1 min à 15 min
  en doublant, pas en boucle serrée ; `4001` = `PendingApproval`, toutes les
  30 s. Une session établie qui se ferme reconnecte vite.
- **Les codes de liaison sont des secrets d'enrôlement.** Émis, relus et
  révoqués par l'espace qu'ils visent, sous `devices: write` ; sept jours
  (`LINK_CODE_TTL_MAX_SECONDS`) et mille usages (`LINK_CODE_MAX_USES`) au plus,
  cinq minutes et un usage par défaut (`LINK_CODE_TTL_SECONDS`), `used_at` date
  le dernier ; 8 caractères pour un code à usage unique valable moins d'une
  heure, 12 au-delà d'une heure ou d'un usage ; un code se compare en majuscules
  sans ses espaces ; le journal dit qu'un code a été émis (espace, durée,
  usages) ou invalidé, jamais sa valeur. L'enrôlement et le téléchargement du
  script (`/api/agent/install/:target`, code dans l'en-tête
  `X-DevEye-Link-Code`) partagent le verrouillage par adresse
  (`src/Services/attempts.ts`, portée `linkcode`), jamais remis à zéro par un
  succès.
- **La commande d'installation** (`manage/installCommand.ts`) nomme le
  serveur que renvoie `devices.linkCodeList` (`ctx.origins.app`, jamais
  l'adresse du navigateur) et porte les droits choisis en options de `link`
  (`--deny`, `--monitor-only`) : c'est la machine qui les retient.
  `/install.sh` et `/install.ps1` sont servis par l'app (`src/agent/routes.ts`),
  rendus une fois depuis `agent/install/`.

## Offre, partage, notifications, export

- **Quota** `agents` (clé `devices.agents` pour le module de facturation) : le
  nombre d'appareils `active` des espaces du propriétaire, 1 sur l'offre
  gratuite et 10 sur Pro. Au-delà, l'hôte met les plus récents en pause et le
  module coupe leur session (`onPlanPause` → `agents.disconnectAgent`) : la
  ligne reste, et quand la place revient la reprise n'a rien à faire, l'agent se
  reconnecte de lui-même. Une installation sans module de facturation n'a
  aucune limite.
- **Partage** : `shareTier: 'open'` dans le registre publié ; un appareil se
  projette vers un autre espace par la coquille commune (`item_shares`), qui le
  lit et pilote son agent selon ses permissions sans le gérer (voir
  [Docs/SHARING.md](../../Docs/SHARING.md)).
- **Notifications** : aucune (`notifies: false`).
- **Export de compte** (`src/server/accountExport.ts`) : les tables de l'espace,
  les listes de processus décompressées appareil par appareil dans l'ordre du
  temps (voir [Docs/ACCOUNT_EXPORT.md](../../Docs/ACCOUNT_EXPORT.md)).

## Vérification

```bash
npm run test:features        # les tests du module, sur le harnais du SDK (aucune base, aucun serveur distant)
npm run typecheck:features
npm run lint:features
npm run format:check:features
```

Après ajout ou retrait d'une classe dans un `*.module.css` du module, depuis
`DevEye/` : `npx tcm features/devices/src --include '**/*.module.css'` (les
`.module.css.d.ts` sont committés).

## Pièges connus

- **Le passage `DeviceRow` → `Device` existe en deux exemplaires** :
  `src/agent/mappers.ts` côté app (`deviceRowToDevice`, pour l'enrôlement et
  les commandes `agent.*`) et `src/server/_shared.ts` côté module
  (`rowToDevice`, pour ses propres lignes). Le publier dans `@deveye/types`
  réunirait les deux ; vivre avec est tenable tant que `Device` ne bouge pas.
- **Le module consomme `@deveye/types` publié** (`minTypesVersion` dans
  `deveye-feature.json`) : un contrat nouveau se publie avant de servir ici.
- **`.sql` lus au runtime** : une migration du socle s'applique au boot, pas au
  rechargement du serveur de développement.
- **Deux dépôts sur les mêmes tables.** Une requête de flotte ou d'historique
  se change dans `features/devices/src/server/repo/`, une requête d'ingestion
  dans `src/db/repos/` ; une colonne dans une migration du socle. Le test du
  module tourne sur un dépôt en mémoire : une requête SQL se vérifie sur une
  base.
