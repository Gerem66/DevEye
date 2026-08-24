# Monitoring — architecture & invariants à préserver

Surveillance des appareils (agent Rust → serveur Fastify → client React). Ce
document décrit le **modèle de collecte** et liste les **décisions de conception
à ne pas casser** lors des évolutions. Contrats partagés dans `@deveye/types`
(`domain/metrics.ts`, `domain/report.ts`, `domain/device.ts`, `domain/presence.ts`,
`protocol/agent.ts`, `features/metrics.ts`, `features/device.ts`).

## Modèle à cadence unique (+ report + presence)

Toute la collecte est **réglable par appareil** et **poussée par le serveur** à
l'agent (`agent.config`) à la connexion **et** à chaque changement.

Un tick = **un instant** : métriques *et* processus, sous un seul `ts`, dans un
seul message (`metrics.batch`). Un point de graphe ne peut donc jamais exister
sans les processus qui l'expliquent.

| Flux | Cadence (défaut) | Contenu | Stockage |
|---|---|---|---|
| **Collecte** | 60 s | CPU/RAM/disque/réseau/charge/temp/GPU/batterie/users/connexions + `process_count` + E/S disque + **liste des processus** (`all`/`top`/`off`). Chaque point est cliquable sur la frise. | `device_metrics` + `device_process_samples` |
| **Report** | 1 h (+ connexion) | OS + posture sécurité + par-disque (`disks[]`) + ports en écoute + connexions. Dernier état seulement. | `devices.report_json` |
| **Presence** | sur transition | online/offline de l'agent (frise de disponibilité). | `device_presence` |

Défauts serveur dans [`DevEye-Types/src/domain/device.ts`](../../DevEye-Types/src/domain/device.ts)
(`DEFAULT_METRIC_INTERVAL_SECONDS` = 60, `DEFAULT_PROCESS_CAPTURE` = `all`,
`DEFAULT_RETENTION_DAYS` = 30) — source unique, lue par le serveur *et* par le
dialogue de configuration.

Rétention : **une seule durée**, `devices.retention_days` (défaut serveur
`MONITORING_RETENTION_DAYS`, 30 j), qui régit les métriques, la présence **et**
les processus. Un relevé est un *instant* : les faire expirer séparément ne
produisait que des instants à moitié lisibles. Balayée chaque heure depuis
[`index.ts`](../index.ts) ; les instants épinglés y échappent.

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
`storage`, `deleteRange`, `setPinnedRange`, `pruneByRetention` travaillent toutes
sur `ts`.

## Invariants / points forts à préserver

Ces choix sont volontaires ; les conserver garde la feature **stable et
maintenable**.

1. **Une seule source de vérité pour la config, poussée à l'agent.** La config
   vit en base (colonnes `devices.*`), est exposée via `device.setConfig`
   (bornée par zod), et **rejouée à la reconnexion** : un agent hors ligne au
   moment du changement applique quand même les bons réglages dès son retour
   (boucle « config-wait » de 2 s avant le 1er snapshot dans `runner.rs`).
   → Ne pas dupliquer la config côté agent ; ne pas l'appliquer uniquement « à
   chaud ».

2. **`null` = inconnu, jamais « pas encore mesuré ».** Toutes les lignes
   métriques ont désormais la même forme : un champ `null` signifie que la sonde
   est indisponible (pas de capteur, pas les droits, plateforme sans l'API), pas
   qu'on est entre deux cycles. `SPARSE_FIELDS` (dans `MonitoringPanel.tsx`) ne
   garde donc plus que les sondes réellement optionnelles (GPU, température,
   charge, batterie, E/S disque). → Un nouveau champ best-effort doit être
   `nullable` ; ne l'ajouter à `SPARSE_FIELDS` que s'il est *intermittent*.

   Corollaire côté types : `metricSnapshotSchema` (ce que l'agent envoie) porte
   `processes`, `metricSeriesPointSchema` (ce que `metrics.query` relit) ne les
   porte pas — une fenêtre de graphe contient des centaines de points et
   trimballer chaque liste coûterait des mégaoctets pour rien.

3. **Downsample : moyenne pour les jauges, max pour les compteurs.** Le `SELECT`
   bucketisé (`(FLOOR(ts/?)*?) AS ts`) et le `GROUP BY` utilisent **la même
   expression** (sinon `only_full_group_by`). Les colonnes entières repassent par
   `intNum()` (l'`AVG()` produit des décimaux qui violeraient `.int()`). Les
   compteurs cumulés (`net*`, `disk_*_bytes`, `uptime`) prennent `MAX`, le débit
   est dérivé côté client. → Respecter ce partage moyenne/max pour toute nouvelle
   colonne.

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

9. **Autorisation owner-or-admin, centralisée.** `authorizeDevice` /
   `authorizeRead` portent l'accès ; les features ne refont pas la logique. →
   Passer par ces helpers.

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
    vraiment sur `0.0.0.0` *et* `::`). C'est l'UI qui fusionne, par
    `(port, joignabilité, interface)`, en unissant protocoles et familles IP
    (`client/src/Features/Monitoring/ports.ts`). → Ne pas dédupliquer côté agent
    sur autre chose que des lignes strictement identiques : l'adresse porte
    l'information d'exposition.

## Cycle de vie d'un appareil & suppression

Statuts (`devices.status`) : `pending` → `active`, `revoked` (réversible via
`device.reactivate`), `pending_deletion`, `archived`.

- **Révocation** (`device.revoke`) : l'agent est refusé à la connexion. Réactivable.
- **Suppression gérée** (`device.requestDelete`, page Appareils) : passe en
  `pending_deletion` en mémorisant le statut précédent (`status_before_delete`).
  - Agent **en ligne** → ordre `agent.destroy` immédiat (`hub.requestDestroy`).
  - Agent **hors ligne** → l'ordre part à sa prochaine connexion (`agent/ws.ts`).
  - L'agent **s'auto-détruit** (`config.rs::self_destruct` : config + token + pid +
    log + binaire) puis répond `agent.destroyed{ok}`. Le serveur **archive** alors
    l'appareil (`devices.archive` : statut `archived`, `token_hash=''`).
  - En cas d'échec (`ok:false`) : `failDeletion` restaure le statut précédent et
    stocke `delete_error` (affiché sur la carte). La suppression est **interrompue**.
  - Annulable (`device.cancelDelete`) tant que l'agent ne s'est pas reconnecté.
- **Archive** : l'appareil disparaît de la page Appareils mais reste **consultable
  en lecture seule** dans Monitoring (voyage temporel). Ses données sont **figées**
  (les balayages de rétention **excluent** `status='archived'`). Pas de config, pas
  d'approbation. L'agent est refusé définitivement.
- **Purge dure** (`device.delete`, bouton de la page Monitoring) : supprime la
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

## Pièges connus

- **`@deveye/types` est miroité, pas symlinké.** Après édition de
  `DevEye-Types/src`, lancer `./sync-types.sh` (mirror + purge cache Vite) ;
  `diff -rq` doit être vide. Committer les **deux** repos ensemble (le serveur/
  client stagés peuvent dépendre de types non encore committés).
- **Cache Vite** après changement de types : `rm -rf client/node_modules/.vite`
  (fait par `sync-types.sh`).
- **`.sql` lus au runtime** : ajouter une migration ne redéclenche pas
  `tsx watch` ; elles s'appliquent au boot.
- **Types CSS générés** : après ajout d'une classe dans un `*.module.css`,
  lancer `npm run gen:css-types` dans `client/` (sinon `styles.maClasse` ne
  compile pas), puis `npx prettier --write "src/**/*.css.d.ts"`.
