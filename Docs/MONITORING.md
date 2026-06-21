# Monitoring — architecture & invariants à préserver

Surveillance des appareils (agent Rust → serveur Fastify → client React). Ce
document décrit le **modèle de collecte** et liste les **décisions de conception
à ne pas casser** lors des évolutions. Contrats partagés dans `deveye-types`
(`domain/metrics.ts`, `domain/report.ts`, `domain/device.ts`, `domain/presence.ts`,
`protocol/agent.ts`, `features/metrics.ts`, `features/device.ts`).

## Modèle à deux cadences (+ report + presence)

Toute la collecte est **réglable par appareil** et **poussée par le serveur** à
l'agent (`agent.config`) à la connexion **et** à chaque changement.

| Flux | Cadence (défaut) | Contenu | Stockage |
|---|---|---|---|
| **Métriques** (léger) | ~10 s | CPU/RAM/disque/réseau/charge/temp/GPU/batterie/users/connexions. **Pas de scan process.** | `device_metrics` |
| **Snapshots** (lourd) | ~5 min | `collect_full` = métriques + `process_count` + E/S disque ; **+ liste des processus** (`all`/`top`/`off`). Points cliquables de la frise. | `device_metrics` + `device_process_samples` |
| **Report** | 1 h (+ connexion) | OS + posture sécurité + par-disque (`disks[]`). Dernier état seulement. | `devices.report_json` |
| **Presence** | sur transition | online/offline de l'agent (frise de disponibilité). | `device_presence` |

Défauts serveur dans [`src/agent/mappers.ts`](../src/agent/mappers.ts)
(`DEFAULT_METRIC_INTERVAL_SECONDS`/`…SNAPSHOT…`/`…CAPTURE`). Rétentions :
`METRICS_RETENTION_DAYS` (métriques + presence, déf. 30 j) et
`PROCESS_RETENTION_DAYS` (processus, déf. **1 j** — la donnée la plus volumineuse),
balayées chaque heure depuis [`index.ts`](../index.ts).

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

2. **Lignes métriques à deux formes.** Les champs remplis seulement au snapshot
   (`processCount`, `diskReadBytes`, `diskWriteBytes`) sont `null` sur les lignes
   fines. Les séries filtrent les `null` ; le live merge garde la dernière valeur
   non-nulle (`SPARSE_FIELDS` dans `Monitoring/index.tsx`). → Tout nouveau champ
   « lourd » doit être `nullable` et ajouté à `SPARSE_FIELDS`.

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
    (`CLICK_SLOP_PX`) ; le clic s'aligne sur le repère de snapshot le plus proche.
    Le `focus` (`live`/`range`/`snapshot`) pilote **fenêtre des graphes,
    résolution, KPI et processus** de façon unifiée. → Garder le `focus` comme
    pilote unique (pas d'états parallèles).

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

- **`deveye-types` est miroité, pas symlinké.** Après édition de
  `DevEye-Types/src`, lancer `./sync-types.sh` (mirror + purge cache Vite) ;
  `diff -rq` doit être vide. Committer les **deux** repos ensemble (le serveur/
  client stagés peuvent dépendre de types non encore committés).
- **Cache Vite** après changement de types : `rm -rf client/node_modules/.vite`
  (fait par `sync-types.sh`).
- **`.sql` lus au runtime** : ajouter une migration ne redéclenche pas
  `tsx watch` ; elles s'appliquent au boot.
