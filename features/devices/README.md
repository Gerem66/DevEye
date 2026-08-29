# Monitoring — architecture & invariants à préserver

Surveillance des appareils (agent Rust → serveur Fastify → client React). Ce
document décrit le **modèle de collecte**, la **carte** du code depuis le
rapatriement d'Appareils en module (29 août 2026, la seizième et dernière
native) et liste les **décisions de conception à ne pas casser** lors des
évolutions.

## La coupure : infrastructure de l'app, feature en module

Deux préfixes de commandes, et c'est la frontière :

- **`agent.*`, le transport, natif.** Vingt-trois relais du `MonitorHub` vers
  l'agent d'un appareil (fichiers, terminal, journaux, paquets, alimentation,
  cycle de vie du processus, privilèges, mise à jour, abonnement aux
  métriques, collecte à la demande) : contrats `features/agent.ts` de
  `@deveye/types`, handlers dans `src/features/agent/`, accessibles à tout
  membre sous le droit `devices`. Avec eux, tout ce qui écrit les tables
  **hors session** : le hub (`src/agent/hub.ts`, état de processus), la socket
  agent et son authentification (`src/agent/ws.ts`), l'ingestion de la
  télémétrie et la présence, l'enrôlement (`POST /api/agent/enroll`, route
  publique) et la distribution des binaires (`src/agent/routes.ts`), la
  composition de `agent.config` (`src/agent/config.ts`), et **la garde
  unique** `authorizeDevice` (`src/agent/authorize.ts`).
- **`devices.*`, la feature, module `features/devices`.** Vingt-cinq
  commandes : la flotte (liste, approbation, révocation, réactivation,
  renommage, rangement, configuration de collecte, partage entre espaces,
  suppression), l'historique stocké (métriques, présence, processus,
  disponibilité, instantanés, épinglage, stockage) et les **codes de liaison**
  (`devices.linkCodeCreate` / `linkCodeList` / `linkCodeSetAutoApprove` /
  `linkCodeRevoke`), qui étaient quatre routes HTTP de session et sont
  devenues des commandes de socket comme les autres (seule leur
  _consommation_, l'enrôlement, reste en HTTP : elle est publique). La
  rétention est un service du module.

Le module parle au hub par la façade `agents` du SDK : `resetAgentSession`
(approbation, réactivation), `disconnectAgent` (révocation, suppression
forcée), `requestDestroy` (suppression gérée), `pushConfig` (cadence ou
capture changée ; l'app recompose la config entière, part des modules
comprise) et `servedManifest` (le manifest des binaires servis, pour signaler
un agent à mettre à jour). Il atteint un appareil par
`ctx.deveye.devices.authorize` (la garde de `src/agent/authorize.ts`, qui porte
déjà « l'administrateur dans son espace personnel voit la flotte »), la liste
de l'espace par `ctx.deveye.devices.list`, les espaces par
`ctx.deveye.workspaces.list` (administrateur). Les gestes de flotte déclarent
`access: { admin: true }` ; ranger, régler la collecte, effacer ou épingler des
relevés, `access: { level: 'write' }` ; le reste se lit sous le droit
`devices`.

**Tables partagées, assumé.** Les six tables (`devices`, `device_workspaces`,
`device_link_codes`, `device_metrics`, `device_process_samples`,
`device_presence`) datent du socle et le restent (allowlist de
`deveye-feature.json`) : l'infrastructure les écrit par ses dépôts
(`src/db/repos/{devices,metrics,presence,processSamples}.ts`, réduits à ce
qu'elle écrit et à ce que la façade lit), le module lit et écrit ce qui relève
de la flotte et de l'historique par **son** dépôt (`src/server/repo/`, un
fichier par table). Une colonne, un index se changent par une migration du
socle.

### Carte du module `features/devices`

```
src/contracts/commands.ts   les 25 commandes devices.* (les anciens features/device.ts
                            et features/metrics.ts du package, plus les codes de liaison)
src/manifest.ts             nativeCapabilities: agents, devices.read, workspaces.read ;
                            resources: devices.list ; settings feature/item « general » ;
                            topbarWidget (appareils en ligne)
src/server/index.ts         serverEntry : createRepo, features, createService (rétention)
src/server/env.ts           MONITORING_RETENTION_DAYS, LINK_CODE_TTL_SECONDS
src/server/_shared.ts       loadDevice (garde + ligne entière), toDevice / rowToDevice,
                            computeAgentUpdate, les accès WRITE et ADMIN
src/server/fleet.ts         les 13 commandes de flotte
src/server/history.ts       les 8 commandes d'historique
src/server/linkCodes.ts     les 4 commandes de codes de liaison
src/server/service.ts       RetentionSweep : le balayage horaire, sur un ticker du SDK
src/server/repo/            devices (+ device_workspaces), linkCodes, metrics, presence,
                            processSamples
src/server/*.test.ts        handlers (35) et service (2), sur le harnais du SDK
```

Le client, `src/client/` :

```
index.tsx                   clientEntry : Widget, Full, settingsPanels.general, TopbarWidget,
                            providers (DEVICES_CLIENT_PROVIDER)
api.ts                      featureApi(manifest) pour devices.*, commandsApi(agentCommands)
                            pour agent.*
store.ts                    les listes espace / flotte, ravivées par le sujet devices
navigation.ts               l'intention « ouvrir la flotte »
Devices.tsx                 la vue : Monitoring, et pour l'admin dans son espace personnel
                            le segment Flotte
Monitoring.tsx              la tuile et la vue Monitoring
MonitoringPanel.tsx         le panneau d'un appareil (DevicePanel du provider)
ConfigPanel.tsx             le panneau general d'un appareil : cadence, capture, rétention
                            (l'ancien ConfigDialog)
TerminalSettings.tsx        le panneau general de la feature (réglages du terminal)
SettingsPanel.tsx           l'aiguillage SettingsPanelProps<string> selon scope.kind
TopbarWidget.tsx            le compteur d'appareils en ligne
TerminalPanel.tsx, FilesPanel.tsx, LogsPanel.tsx, PackagesPanel.tsx, PowerMenu.tsx
                            le transport agent.* et onServerEvent
DeviceWidget.tsx            la tuile d'un appareil (DeviceWidget du provider), avec
                            DeviceWidget.module.css
deviceUsage.ts, agentUpdates.ts, agentVersion.ts, terminalPrefs.ts, useAgentUpdate.tsx,
utils.ts                    les stores et utilitaires du client
Connections.tsx, DeviceActionsMenu.tsx, GraphDetail.tsx, HardwareInfo.tsx, MiniGraph.tsx,
MonitoringInfo.tsx, MonthPicker.tsx, OpenPorts.tsx, PrivilegeInfo.tsx, Timeline.tsx, ports.ts
                            les composants du panneau
style.module.css, terminalFont.css
fleet/Fleet.tsx             la page d'administration de la flotte
fleet/useLinkCodes.tsx      les quatre devices.linkCode*
fleet/useDeviceActions.tsx, fleet/WorkspaceShareDialog.tsx, fleet/DeviceCard.tsx,
fleet/LinkCodesDialog.tsx, fleet/LinkInfo.tsx
                            les gestes de flotte et leurs dialogues
fleet/DownloadAgent.tsx     la distribution des binaires, sur /api/agent/* en HTTP
fleet/format.ts, fleet/style.module.css
```

Le client offre à l'app `DEVICES_CLIENT_PROVIDER` (`useDevices`, `DevicePanel`,
`DeviceWidget`), que l'accueil compose pour ses tuiles et ses vues par
appareil ; l'app ne connaît plus aucun écran d'appareil en propre. La
configuration de collecte est le panneau `general` d'un appareil dans la
coquille de réglages, les réglages du terminal le panneau `general` de la
feature.

## Modèle à cadence unique (+ report + presence)

Toute la collecte est **réglable par appareil** et **poussée par le serveur** à
l'agent (`agent.config`) à la connexion **et** à chaque changement.

Un tick = **un instant** : métriques _et_ processus, sous un seul `ts`, dans un
seul message (`metrics.batch`). Un point de graphe ne peut donc jamais exister
sans les processus qui l'expliquent.

| Flux         | Cadence (défaut)  | Contenu                                                                                                                                                                                | Stockage                                    |
| ------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Collecte** | 60 s              | CPU/RAM/disque/réseau/charge/temp/GPU/batterie/users/connexions + `process_count` + E/S disque + **liste des processus** (`all`/`top`/`off`). Chaque point est cliquable sur la frise. | `device_metrics` + `device_process_samples` |
| **Report**   | 1 h (+ connexion) | OS + posture sécurité + par-disque (`disks[]`) + ports en écoute + connexions. Dernier état seulement.                                                                                 | `devices.report_json`                       |
| **Presence** | sur transition    | online/offline de l'agent (frise de disponibilité).                                                                                                                                    | `device_presence`                           |

Défauts serveur dans [`DevEye-Types/src/domain/device.ts`](../../DevEye-Types/src/domain/device.ts)
(`DEFAULT_METRIC_INTERVAL_SECONDS` = 60, `DEFAULT_PROCESS_CAPTURE` = `all`,
`DEFAULT_RETENTION_DAYS` = 30) — source unique, lue par le serveur _et_ par le
panneau de configuration.

Rétention : **une seule durée**, `devices.retention_days` (défaut serveur
`MONITORING_RETENTION_DAYS`, 30 j, lue par le module dans son `env.ts`), qui
régit les métriques, la présence **et** les processus. Un relevé est un
_instant_ : les faire expirer séparément ne produisait que des instants à
moitié lisibles. Balayée chaque heure par le service du module
(`features/devices/src/server/service.ts`, un passage au démarrage puis un
ticker du SDK) ; les instants épinglés y échappent, les appareils archivés
sont figés.

### Une seule énumération par tick

Le coût du tick vient de deux sondes, partagées par tous les signaux :

- **`ps` étendu** (`report::scan_processes`) → liste des processus, `process_count`,
  et sur Linux les E/S par process via `/proc/<pid>/io`. Élargir le format de `ps`
  ne coûte rien de mesurable, d'où pid/threads/user/uptime « gratuits ».
- **`ss -tuanpH`** (`sockets::read_sockets`) → ports en écoute, connexions
  établies, `activeConnections` **et** connexions entrantes/sortantes par process.
  Cette sonde unique remplace les trois d'avant (`ss -tulnH` + `ss -tn state
established` ×2) et coûte moins cher au total.

Mesuré sur une machine à 700 processus : **~40 ms par tick**, soit moins que
l'ancien cycle lourd, pour 10× plus d'instants historisés.

### Stockage des processus

Une ligne par instant, la liste étant un **blob JSON gzip** (`payload`), et non
une ligne par processus. À 60 s, le modèle ligne-par-process coûterait
~120 Mo/jour/appareil ; le blob coûte ~7 Mo. C'est sûr parce qu'**aucune requête
n'agrège les processus par nom à travers le temps** : `nearest`, `snapshotTimes`,
`storage`, `deleteRange`, `setInstantsPinned`, `pruneByRetention` travaillent
toutes sur `ts`.

## Invariants / points forts à préserver

Ces choix sont volontaires ; les conserver garde la feature **stable et
maintenable**.

1. **Une seule source de vérité pour la config, poussée à l'agent.** La config
   vit en base (colonnes `devices.*`), est exposée via `devices.setConfig`
   (bornée par zod), et **rejouée à la reconnexion** : un agent hors ligne au
   moment du changement applique quand même les bons réglages dès son retour
   (boucle « config-wait » de 2 s avant le 1er snapshot dans `runner.rs`).
   → Ne pas dupliquer la config côté agent ; ne pas l'appliquer uniquement « à
   chaud ».

2. **`null` = inconnu, jamais « pas encore mesuré ».** Toutes les lignes
   métriques ont désormais la même forme : un champ `null` signifie que la sonde
   est indisponible (pas de capteur, pas les droits, plateforme sans l'API), pas
   qu'on est entre deux cycles. `SPARSE_FIELDS` (dans `MonitoringPanel.tsx` du
   module) ne garde donc plus que les sondes réellement optionnelles (GPU,
   température, charge, batterie, E/S disque). → Un nouveau champ best-effort
   doit être `nullable` ; ne l'ajouter à `SPARSE_FIELDS` que s'il est
   _intermittent_.

    Corollaire côté types : `metricSnapshotSchema` (ce que l'agent envoie) porte
    `processes`, `metricSeriesPointSchema` (ce que `devices.metrics` relit) ne les
    porte pas — une fenêtre de graphe contient des centaines de points et
    trimballer chaque liste coûterait des mégaoctets pour rien.

3. **Downsample : moyenne pour les jauges, max pour les compteurs.** Le `SELECT`
   bucketisé (`(FLOOR(ts/?)*?) AS ts`) et le `GROUP BY` utilisent **la même
   expression** (sinon `only_full_group_by`). Les colonnes entières repassent par
   `intNum()` (l'`AVG()` produit des décimaux qui violeraient `.int()`). Les
   compteurs cumulés (`net*`, `disk_*_bytes`, `uptime`) prennent `MAX`, le débit
   est dérivé côté client. → Respecter ce partage moyenne/max pour toute nouvelle
   colonne, dans le dépôt du module (`repo/metrics.ts`) comme dans celui du
   socle.

4. **Bucketisation par jour locale en math entière.** `availableDays` calcule le
   jour local via `FLOOR((ts - tzOffsetMs)/86400000)` (offset = client
   `getTimezoneOffset()`), **indépendamment du fuseau MySQL/Node**. Le calendrier
   désactive les jours futurs. → Pas de dépendance au `time_zone` de session SQL.

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
   m'est-il visible ? » : la ligne existe et est partagée avec l'espace actif
   (`device_workspaces`), l'administrateur global passant outre. Le transport
   l'appelle directement, le module par `ctx.deveye.devices.authorize`, la
   façade du SDK pour les autres modules. Le **niveau** exigé (`read`, `write`,
   `admin`) est déclaré par chaque commande dans son `access`, appliqué par le
   dispatcheur avant le handler. → Ne jamais refaire la règle ailleurs, ni
   décider d'un niveau dans un handler.

10. **Frise : clic = instant, glissé = plage.** Distinction par seuil
    (`CLICK_SLOP_PX`) ; le clic s'aligne sur le repère le plus proche. Le `focus`
    (`live`/`range`/`snapshot`) pilote **fenêtre des graphes, résolution, KPI et
    processus** de façon unifiée. → Garder le `focus` comme pilote unique (pas
    d'états parallèles).

    Chaque point étant un instant complet, les repères sont ~1440/jour : au-delà
    de `MAX_INDIVIDUAL_MARKS` la frise dessine des **bandes continues** au lieu de
    traits (les instants épinglés restent visibles individuellement). → Ne pas
    revenir à un rendu un-div-par-repère.

11. **Ports : une bulle = un port joignable de la même façon.** L'agent renvoie
    une entrée **par adresse de bind** (correct : un service dual-stack écoute
    vraiment sur `0.0.0.0` _et_ `::`). C'est l'UI qui fusionne, par
    `(port, joignabilité, interface)`, en unissant protocoles et familles IP
    (`ports.ts` du client du module). → Ne pas dédupliquer côté agent sur autre
    chose que des lignes strictement identiques : l'adresse porte l'information
    d'exposition.

12. **La liste de l'espace vient de la façade, les lignes du module.**
    `devices.list` en portée `workspace` demande à `ctx.deveye.devices.list`
    _quels_ appareils l'espace voit et dans quel ordre (le rang de l'espace, la
    date pour départager ; l'espace personnel d'un administrateur voit tout),
    puis relit les lignes entières par son dépôt. La portée `fleet` exige
    `ctx.isAdmin` et lit tout. → Ne pas réécrire la règle de visibilité dans le
    module : elle est celle de la garde.

## Cycle de vie d'un appareil & suppression

Statuts (`devices.status`) : `pending` → `active`, `revoked` (réversible via
`devices.reactivate`), `pending_deletion`, `archived`.

- **Appairage** : un administrateur émet un code (`devices.linkCodeCreate`,
  dans l'espace actif, ou dans tout espace existant s'il le nomme : la même
  liste que le partage, `workspaces.list`), l'agent le présente à
  `POST /api/agent/enroll` qui crée l'appareil (`pending`, ou `active` si le
  code approuve d'office) et diffuse `devices` à l'espace.
- **Approbation** (`devices.confirm`) : l'appareil passe `active` et le hub
  remet sa session à zéro (`agents.resetAgentSession`) : sans cela, un agent
  déjà connecté verrait sa télémétrie accusée puis jetée.
- **Révocation** (`devices.revoke`) : la session est coupée tout de suite
  (`agents.disconnectAgent`), l'agent refusé à la reconnexion. Réactivable.
- **Suppression gérée** (`devices.requestDelete`, page Appareils) : passe en
  `pending_deletion` en mémorisant le statut précédent (`status_before_delete`).
    - Agent **en ligne** → ordre `agent.destroy` immédiat (`agents.requestDestroy`).
    - Agent **hors ligne** → l'ordre part à sa prochaine connexion (`agent/ws.ts`).
    - L'agent **s'auto-détruit** (`config.rs::self_destruct` : config + token + pid +
      log + binaire) puis répond `agent.destroyed{ok}`. Le serveur **archive** alors
      l'appareil (dépôt du socle, `archive` : statut `archived`, `token_hash=''`).
    - En cas d'échec (`ok:false`) : `failDeletion` restaure le statut précédent et
      stocke `delete_error` (affiché sur la carte). La suppression est **interrompue**.
    - Annulable (`devices.cancelDelete`) tant que l'agent ne s'est pas reconnecté.
- **Archive** : l'appareil disparaît de la page Appareils mais reste **consultable
  en lecture seule** dans Monitoring (voyage temporel). Ses données sont **figées**
  (les balayages de rétention **excluent** `status='archived'`). Pas de config, pas
  d'approbation. L'agent est refusé définitivement. `devices.forceDelete`
  archive sans attendre l'auto-destruction (agent disparu), en coupant la
  session.
- **Purge dure** (`devices.delete`, bouton de la page Monitoring) : supprime la
  ligne + tout l'historique (cascade FK). Disponible quel que soit l'état (agent
  connecté ou non) ; ne déclenche **pas** d'auto-destruction.

### Invariants de sécurité à préserver

- **Furtivité** (`agent/ws.ts`) : tout échec d'auth/autorisation (jeton absent /
  invalide, appareil inconnu, révoqué, archivé, empreinte de jeton fausse) **se
  ferme exactement de la même façon** (`close(1008)`, sans raison). De l'extérieur,
  impossible de distinguer ces cas — c'est volontaire (anti-énumération). Seuls
  `pending`/`active` sont acceptés ; `pending_deletion` l'est juste le temps de
  recevoir l'ordre d'auto-destruction.
- **Backoff de rejet** (`agent/runner.rs`) : une fermeture au handshake (avant la
  config) = `SessionOutcome::Rejected` → nouvelle tentative **toutes les heures**
  (`REJECTED_RETRY`), pas en boucle serrée. Une session établie qui se ferme
  reconnecte vite.
- **Les codes de liaison sont des secrets d'enrôlement.** Émis, relus,
  retouchés et révoqués par leur émetteur seul, administrateur global ; un
  code se compare en majuscules sans ses espaces ; le journal dit qu'un code a
  été émis (espace, durée, auto-approbation), jamais sa valeur. L'enrôlement
  est plafonné par adresse (`rateLimit` de la route).

## Pièges connus

- **`@deveye/types` est miroité, pas symlinké.** Après édition de
  `DevEye-Types/src`, refaire le miroir depuis la racine du workspace
  (`rsync -a --delete DevEye-Types/src/ DevEye/node_modules/@deveye/types/src/`,
  et de même vers `DevEye-Feature-Template` et `DevEye-CloudSync`) ;
  `diff -rq` doit être vide. Committer les **deux** repos ensemble (le serveur/
  client stagés peuvent dépendre de types non encore committés).
- **Cache Vite** après changement de types : `rm -rf client/node_modules/.vite`.
- **`.sql` lus au runtime** : ajouter une migration ne redéclenche pas
  `tsx watch` ; elles s'appliquent au boot.
- **Types CSS générés** : après ajout d'une classe dans un `*.module.css`,
  lancer `npm run gen:css-types` dans `client/` (sinon `styles.maClasse` ne
  compile pas), puis `npx prettier --write "src/**/*.css.d.ts"`.
- **Deux dépôts sur les mêmes tables.** Une requête de flotte ou d'historique
  se change dans `features/devices/src/server/repo/`, une requête d'ingestion
  dans `src/db/repos/` ; une colonne dans une migration du socle. Le test du
  module tourne sur un dépôt en mémoire : une requête SQL se vérifie sur une
  base.
