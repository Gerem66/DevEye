# Sentinelle — architecture & invariants à préserver

Détection d'intrusion sur les hôtes (agent Rust → serveur Fastify → client React).
Monitoring **collecte**, Sentinelle **interprète** : rien ici n'ouvre une sonde de
son propre chef sans que ce document l'explique.

Sentinelle est un **module** (`features/sentinel/`, septième native rapatriée
sur le SDK des features, voir [Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md)). Ses contrats
vivent dans `features/sentinel/src/contracts/` (`domain.ts`, `commands.ts`) ;
`@deveye/types` ne garde que le protocole agent (`domain/report.ts`,
`protocol/agent.ts`), l'identité de la feature (id, descripteur, sujet live,
émetteur de notifications) et le couplage déclaré vers l'app
(`sdk/providers.ts` : `SENTINEL_AGENT_CONFIG_PROVIDER`,
`DEFAULT_SENTINEL_INTEGRITY_MINUTES`).

## Où vit le code

| Où                         | Quoi                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/engine.ts`     | le moteur (l'ex `SecurityMonitor`) : file d'ingestion, évaluation par tour, ligne de base en mémoire, plancher d'évaluation, passe lente, notifications groupées, `live.changed` ; ses hooks agent |
| `src/server/rules.ts`      | le catalogue de règles, fonctions pures ; `rules.test.ts` les vérifie (31 cas)                                                                                                                     |
| `src/server/repo.ts`       | ligne de base, constats, autorisations, config par appareil (`deviceConfig`)                                                                                                                       |
| `src/server/handlers.ts`   | les 13 commandes `sentinel.*` ; `_shared.ts` la posture, les DTO, le singleton du moteur                                                                                                           |
| `src/server/notice.ts`     | la mise en page Discord d'un constat                                                                                                                                                               |
| `src/server/env.ts`        | `SENTINEL_TICK_SECONDS` (60), `SENTINEL_LEARNING_DAYS` (7), `SENTINEL_FINDING_RETENTION_DAYS` (180), lues par le module                                                                            |
| `src/server/uninstall.sql` | démonte `ft_sentinel_device_config`, la seule table du module au préfixe                                                                                                                           |
| `src/client/`              | la vue (`Sentinel.tsx`), la carte (`SentinelWidget`), le panneau Appareils de la coquille (`SentinelDevicesPanel`), le magasin du décompte (`store.ts`)                                            |

Ce que l'app garde : les handlers agent (`src/agent/handlers/telemetry.ts`,
`security.ts`), qui persistent puis tendent la télémétrie aux hooks des modules
sans rien garder des réglages de Sentinelle ; `src/agent/config.ts`, qui
recompose la config poussée à l'agent (`agent.config`) avec la part du module
(le provider) ; et la façade du SDK (`devices`, `telemetry`, `agents`,
`notify`), seul chemin du module vers les appareils, les instants et la flotte.

À lire avec [Appareils](../devices/README.md), dont les invariants 1, 2, 6, 8 et 9
s'appliquent ici tels quels.

## Ce que Sentinelle ne fait pas

Aucun suivi de l'activité des utilisateurs. La sonde d'authentification remonte
des **issues** (une tentative a réussi ou échoué, depuis quelle adresse, contre
quel compte) et jamais ce que quelqu'un fait de sa session ; la sonde de
persistance remonte des **empreintes** et jamais le contenu d'un fichier.

Ce n'est pas une limitation technique : l'agent a les droits de lire bien
davantage. C'est la frontière de la feature, et elle est appliquée à la source :
`authlog.rs` compte les élévations `sudo` alors que la commande exécutée est sur
la même ligne, et ne l'emporte pas.

## Ce qu'on peut faire croire à Sentinelle, et ce qu'on ne peut pas

Un détecteur d'intrusion lit des traces que l'intrus cherche à fausser. Ce qui
suit dit où passe la limite.

- **Un compte sans privilège ne fabrique pas de constat d'authentification.**
  L'identifiant syslog (`sshd`, `useradd`) est au choix de qui écrit :
  `logger -t sshd "Failed password for root from …"` suffit à le porter. La sonde
  lit donc journald en JSON et ne retient une entrée `sshd` ou `useradd` que si
  `_UID` vaut 0, champ que journald pose lui-même depuis la socket. `sudo` écrit
  sous l'uid de qui l'invoque : on n'en garde que le fait (une élévation), jamais
  le texte, qu'un faux pourrait habiller en échec de connexion.
- **Un flot ne rend pas la fenêtre « calme ».** Au plafond de lignes, ce sont
  les plus récentes qui sont comptées, et la fenêtre est marquée `truncated` :
  les règles l'écrivent dans la preuve (« compteurs minorés ») plutôt que de
  laisser un chiffre partiel passer pour exact.
- **Un journal illisible n'est pas un journal vide** : `unavailable`, et aucune
  règle ne conclut.
- **Le repli sur `/var/log/auth.log` n'a pas cette garantie.** Sans journald, le
  fichier ne dit pas qui a écrit une ligne ; sur une machine où un compte
  ordinaire peut y écrire (syslog ouvert à tous), un faux passe. C'est le cas
  rare, et il est connu.
- **Root local peut tout.** Effacer le journal, réécrire le manifeste de
  persistance, tuer l'agent : rien de ce qu'un agent lit sur une machine ne vaut
  contre qui la possède déjà. Sentinelle voit l'arrivée, pas l'occupant installé.

## Trois notions, à ne pas confondre

|                   | Quoi                                               | Où                   | Reconstructible ?              |
| ----------------- | -------------------------------------------------- | -------------------- | ------------------------------ |
| **Ligne de base** | ce qui a été _observé_ — des faits, sans jugement  | `device_baseline`    | oui (`sentinel.resetBaseline`) |
| **Constat**       | un écart _jugé_ digne d'être montré                | `device_findings`    | non — c'est une preuve         |
| **Autorisation**  | une décision _humaine_ : « ceci est légitime ici » | `sentinel_allowlist` | **jamais**                     |

Les autorisations sont rangées à part de la ligne de base, et c'est le point le
plus important du schéma. Les mélanger ferait redemander à l'utilisateur, machine
par machine, de rejuger ce qu'il avait déjà jugé après chaque montée de version
d'agent — la façon la plus sûre de faire abandonner la feature.

## Les flux

| Flux                 | Cadence (défaut)                  | Contenu                                                                                | Stockage                      |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| **Instant**          | 60 s                              | réutilise `metrics.batch` : processus (nom, **chemin**, compte, ports, connexions)     | déjà en base                  |
| **Rapport**          | 1 h                               | réutilise `agent.report` : posture étendue (sshd, MAC, reboot, correctifs de sécurité) | `devices.report_json`         |
| **Persistance**      | 6 h (+ connexion, + `agent.scan`) | empreintes SHA-256 des surfaces d'installation au démarrage                            | **diffé, jamais stocké brut** |
| **Authentification** | 1 h                               | compteurs + ≤50 adresses + ≤50 connexions                                              | **conclusions seules**        |

Réglages par appareil : `ft_sentinel_device_config` (une ligne par appareil
surveillé ou l'ayant été, migration 098 du socle ; l'absence de ligne vaut
« sondes éteintes, défauts » ; `ON DELETE CASCADE` avec l'appareil), poussés à
l'agent par `agent.config` et **rejoués à la reconnexion** (invariant 1 de
Monitoring). C'est l'app qui compose cette config (`agentConfigFor`), en
demandant au module sa part par `SENTINEL_AGENT_CONFIG_PROVIDER` : sans module
installé, ou sans ligne pour l'appareil, les sondes sont éteintes.

Les colonnes ont vécu dans `devices` (`sentinel_*`, migration 074) jusqu'au
rapatriement : la 098 du socle crée la table du module et y copie les appareils
qui ont eu Sentinelle, puis supprime les colonnes. Le socle, et non une
migration du module, parce que ses migrations tournent avant celles des modules
et qu'une copie faite par le module trouverait des colonnes déjà supprimées.

### Le travail de connexion est borné des deux côtés

Rapport et relevés partent **aussi** à la connexion, pour qu'une machine qu'on
vient d'allumer rende son état sans attendre son premier tour d'horloge. Mais une
machine qui se **reconnecte en boucle** les rejouait alors autant de fois : le
serveur réévaluait ses règles à chaque coup, et un constat `port.*` ou `posture.*`
de cadence horaire finissait « constaté 300 fois » en quelques heures — pour un
travail qui empreinte des centaines de fichiers et lit des journaux.

Deux gardes, délibérément aux deux bouts :

- **Agent** (`runner.rs`) : `ConnectMarks` retient quand chaque travail a été fait
  pour la dernière fois, **au-delà de la session** pour survivre à une
  reconnexion ; `due_at` décide. `MIN_CONNECT_WORK_GAP` vaut 15 min contre une
  cadence nominale d'une heure. Au lancement du processus les jalons sont `None`,
  donc un vrai démarrage ne perd rien. Les tickers **posent** le jalon eux aussi, sinon un tour d'horloge suivi
  d'une reconnexion serait immédiatement rejoué. `agent.collect` et `agent.scan`
  ne sont jamais bornés : ce sont des ordres explicites.
- **Serveur** (`features/sentinel/src/server/engine.ts`) : `EVAL_FLOOR_MS` (10 min) plafonne la
  réévaluation de `report` / `auth` / `integrity` par appareil. Nécessaire _en
  plus_ du garde agent, pour deux raisons : la flotte se met à jour à son rythme,
  et un `Instant` est relatif au processus, donc un agent qui **plante** en boucle
  repart sans mémoire. L'ingestion n'est pas touchée — `report_json`, les ports et
  la ligne de base s'écrivent comme avant ; seule la relecture des règles est
  bornée.

Piège refermé au passage : sauter une évaluation saute **aussi** son entrée dans
`replayed`. Annoncer une famille rejouée sans lui fournir de constats la ferait
résoudre en bloc — le détecteur qui s'éteint sans bruit de l'invariant plus bas.

Ces gardes rendent le symptôme invisible, donc le hub **signale** désormais les
rafales de reconnexion (`noteReconnect`, au-delà de 12 connexions par heure et par
appareil). Les taire sans le dire aurait remplacé un bug voyant par un bug muet.

## Invariants à préserver

1. **L'ingestion n'évalue pas.** Un lot de métriques peut porter cent instants
   (agent revenu après une coupure). Les handlers d'agent de l'app
   (`src/agent/handlers/`) persistent, puis tendent ce qu'ils ont persisté aux
   hooks des modules (`onReport`, `onMetricsBatch`, `onIntegrity`,
   `onAuthEvents`) pour tout appareil **actif** ; les hooks du module relisent
   sa config (surveillé ? sonde d'auth allumée ?) et se contentent
   d'`enqueue*()` ; le moteur draine au tour de boucle, **ne garde que le
   dernier instant par appareil**, et évalue. → Ne jamais appeler une règle
   depuis un hook ni depuis `src/agent/handlers/`.

2. **La fenêtre d'apprentissage n'est pas négociable.** Pendant qu'elle court
   (`ft_sentinel_device_config.learning_until`, 7 j par défaut), tout est absorbé dans la
   ligne de base et les règles de dérive se taisent. Sans elle, le premier jour
   produit trois cents constats « nouveau programme » et la liste devient
   illisible avant d'avoir servi. Les règles qui n'en dépendent pas (`exec.*`,
   `net.*`, `posture.*`, `auth.*`) restent actives — un binaire dans `/tmp` est
   anormal le jour 1 comme le jour 100. → `SENTINEL_RULES[...].needsBaseline` est
   la source unique de cette distinction.

3. **La ligne de base se fusionne, jamais ne se remplace.** `baseline.observe()`
   réécrit `attrs` en bloc ; c'est au moteur d'unir comptes et ports avec ce qui
   est connu avant d'écrire. Sans cela, un programme tournant sous deux comptes
   déclencherait `process.user_changed` à chaque alternance, et l'enveloppe CPU
   serait recalculée depuis une seule mesure. → Voir `observeSnapshot`.

4. **Elle s'écrit après l'évaluation.** L'inverse ferait qu'un programme nouveau
   serait déjà connu au moment où l'on se demande s'il est nouveau, et
   `process.new` ne se déclencherait jamais.

5. **La clé d'un programme est `(nom, chemin)`.** Agréger sur le seul nom
   fusionnait deux binaires homonymes rangés à des endroits différents —
   exactement ce derrière quoi un imposteur se cache. → Après une montée de
   version d'agent qui change ce qui est observé, lancer `sentinel.resetBaseline`
   (les autorisations survivent).

6. **`null` = pas mesuré, jamais « tout va bien ».** Un contrôle de posture dont
   la sonde n'a rien dit vaut `unknown` et **ne compte pas dans le score** ; le
   diluer récompenserait une machine qui ne mesure rien. Une règle dont la sonde
   est absente ne se déclenche pas — elle ne se déclenche pas « à vide ».
   `report.agent.probes` dit ce que l'agent **sait faire**, ce qui distingue « la
   sonde a échoué ici » d'« agent trop ancien » : les deux rendent `null`, mais
   l'un envoie inspecter la machine et l'autre la mettre à jour. → Ajouter une
   sonde, c'est ajouter son nom à `PROBES` dans `report.rs`.

7. **Notifier aux transitions seulement, et grouper.** `device_findings.state`
   porte l'état courant (même discipline que `database_alerts.firing`). Seul un
   constat qui vient de s'ouvrir notifie, à partir de `high`, et les constats d'un
   même appareil dans un même tour partent en **un seul message** : une machine
   compromise déclenche vingt règles d'un coup, et vingt mails ne se lisent pas.
   **Ses propres canaux**, et rien d'emprunté. Sentinelle a d'abord réutilisé
   ceux d'Uptime « pour éviter deux jeux de réglages » : on recevait alors une
   alerte de sécurité sur un salon désigné pour la disponibilité, sans que rien
   ne l'ait annoncé ni ne permette de l'éteindre séparément. Le **mécanisme**
   est commun (`Services/notifications.ts`, une table `notification_settings`
   indexée par `(espace, feature)`), la **configuration** ne l'est pas — et elle
   est éteinte par défaut.

8. **Acquitter écrit une autorisation, dans cet ordre.** L'autorisation d'abord,
   la résolution ensuite : si l'écriture échoue, le constat reste ouvert plutôt
   que de disparaître sans que rien n'empêche son retour. Rouvrir retire
   l'autorisation — sinon le moteur refiltrerait le constat au tour suivant et la
   réouverture s'annulerait toute seule.

    Corollaire d'interface : les décisions doivent rester **visibles et
    révocables** (section « Décisions »). Sans cet écran, acquitter était un aller
    sans retour — on créait des autorisations sans jamais pouvoir savoir
    lesquelles existaient ni revenir dessus, et une décision d'un jour devenait un
    angle mort permanent.

    **« Réglé » n'est pas « légitime », et les deux sorties doivent exister.** Le
    moteur ne résout de lui-même que ce qu'il sait rejouer (`SNAPSHOT_RULES`, via
    `resolveMissing`) : un constat d'événement — `auth.*`, `persistence.*` — décrit
    un fait passé, donc plus aucun relevé ne cessera de le porter, et il reste
    ouvert indéfiniment même après correction. `sentinel.resolve` le ferme **sans
    écrire d'autorisation** : il rouvrira au premier relevé qui le revoit, là où un
    acquittement l'aurait fait taire pour toujours. N'offrir que l'acquittement
    revenait à faire déclarer normal ce qui venait d'être corrigé — et à empoisonner
    l'allowlist, qui est le seul état que rien ne reconstruit.

9. **Un constat ≥ `high` épingle son instant.** Via `telemetry.pinInstant` de la
   façade du SDK, qui traite les deux tables en une instruction. Sans cela la rétention
   effacerait, trente jours plus tard, la seule liste de processus qui explique le
   constat. Les constats eux-mêmes ne suivent pas `retention_days` : ce sont des
   preuves. Seuls les `resolved` sont balayés, après
   `SENTINEL_FINDING_RETENTION_DAYS` (180 j) ; les ouverts jamais.

    Refusable par appareil (`pin_evidence`, actif par défaut). Ces instants gardés
    apparaissent dans l'historique de Monitoring, où rien ne disait d'où ils
    venaient : une feature qui pose des relevés durables chez une autre doit
    pouvoir se laisser refuser depuis ses propres réglages.

10. **« Binaire supprimé » veut dire « plus rien à ce chemin ».** Le noyau
    suffixe `/proc/<pid>/exe` de « (deleted) » pour deux situations opposées :
    l'exécutable a disparu (implant résident, ce qu'on cherche) ou il a été
    **remplacé**, ce que fait tout gestionnaire de paquets par un `rename()`
    par-dessus. Sans le discriminant — le chemin pointe-t-il encore sur un
    fichier ? — chaque `dnf update` faisait sonner en `critical` la moitié des
    processus au long cours d'un serveur. → Voir `proc_exe` et son test jumeau.

11. **Un fil du noyau n'entre pas dans la ligne de base.** Son nom encode un CPU
    et un index que le noyau recycle en continu (`kworker/6:0H-kblockd`,
    `jbd2/nvme1n1p1-8`), si bien que chacun franchissait les seuils de
    `process.vanished` puis s'évaporait sans jamais se résoudre : des centaines de
    constats ouverts pour un phénomène qui n'est pas un événement. Le discriminant
    est `PF_KTHREAD`, que l'agent lit dans `/proc/<pid>/stat` et remonte en
    `kernel` ; le nom ne sert que de repli, sur son `/` qu'un nom de base
    d'exécutable n'a jamais. Un nom de fil du noyau porté par un binaire du disque
    reste ce que `exec.masquerade` cherche.

12. **Un manifeste tronqué ne prouve aucune suppression.** `truncated` coupe
    `persistence.removed` **et** l'oubli en ligne de base : il ne dit pas qu'une
    entrée a disparu, seulement qu'on a cessé de regarder.

13. **Éteint par défaut, appareil par appareil.** Activer Sentinelle est un geste
    explicite : c'est lui qui autorise la lecture des journaux d'authentification,
    et cela ne doit pas arriver par effet de bord de l'ouverture d'une feature.
    La sonde d'auth a son propre interrupteur sous celui de la feature.

14. **Rien n'est chiffré.** Ce sont des faits sur des machines, même palier que
    `devices.report_json`. C'est ce qui laisse le moteur tourner **sans session ni
    mot de passe**, sans le détour par le chiffre « open » qu'impose Uptime (voir
    `Docs/SECURITY_MODEL.md`). → Ne pas y ranger de secret d'utilisateur.

15. **Le séparateur des clés composées est un `�`,** déclaré une fois
    (`KEY_SEP` dans `features/sentinel/src/server/repo.ts`) et lu par `allowSubject()`. Un NUL
    plutôt qu'un espace parce qu'un sujet est souvent un chemin ; écrit en
    échappement parce qu'un octet invisible en source disparaît au premier
    copier-coller — et le perdre changerait **toutes** les empreintes de
    dédoublonnage d'un coup. → Ne jamais le retaper à la main ailleurs.

16. **Une règle ne se rejoue qu'à la cadence de ce qui la nourrit.** Chaque flux
    a la sienne (tableau plus haut) : l'instant toutes les 60 s, le rapport
    toutes les heures. `evaluateSnapshot` ne prend que ce qui lit `ctx.snapshot`,
    `evaluateReport` ce qui lit `ctx.report` ; persistance et authentification
    arrivent sur leurs propres relevés. Chaque famille a son jeu de règles
    résolubles (`SNAPSHOT_RULES` / `REPORT_RULES`), et `record()` ne résout que
    celles qu'on vient effectivement de rejouer.

    **C'est la source qui range une règle, pas son préfixe.** `net.mining_pool`
    est une règle de rapport : les connexions établies vivent dans
    `report.connections`, l'instant ne porte que le compteur
    `activeConnections`. La ranger avec `net.shell_outbound`, qui lit bien
    l'instant, suffisait à lui rendre le défaut décrit plus bas. En cas de doute,
    la question n'est pas « de quoi ça parle » mais « qu'est-ce que la fonction
    lit dans `ctx` ».

    La posture a d'abord vécu dans `evaluateSnapshot`, et les deux pannes qui en
    découlaient disent pourquoi cet invariant existe. **Un constat se
    re-constatait chaque minute sur un rapport inchangé** : `occurrences`
    comptait des tours de moteur (1206 en quatre jours pour une donnée relevée
    96 fois) et `last_seen` annonçait « il y a 5 min » un fait mesuré jusqu'à une
    heure plus tôt — de quoi partir chercher sur la machine un problème déjà
    corrigé. Et surtout, **un rapport arrivé sans instant résolvait d'un coup
    tous les `exec.*` / `net.*` / `process.*`** : les règles rendaient `[]` faute
    de `ctx.snapshot`, et `resolveMissing` prenait ce silence pour une
    disparition. Un détecteur qui s'éteint sans bruit, exactement le mode de
    panne contre lequel `rules.test.ts` est le seul filet. → Voir la section
    « Séparation des cadences » de ce test.

## L'interface : deux niveaux, aucun onglet

On entre par **la flotte** — qu'est-ce qui ne va pas, et où — et on descend sur
**une machine**, qui se lit d'une seule traite : ses constats, sa posture, ce
qu'on a appris d'elle, les décisions prises à son sujet.

Une première version rangeait ces quatre choses derrière des onglets. C'était une
erreur de découpage : elles ne s'excluent pas, elles se lisent **ensemble et dans
cet ordre**. On ne consulte pas la posture d'une machine _ou_ ses constats — on
regarde les constats et on se demande aussitôt si sa configuration les explique.

Trois règles en découlent, à préserver :

- **Cliquer le nom d'une machine ouvre sa lecture, jamais un formulaire.** La
  version à onglets basculait sur « Réglages » quand la machine n'était pas
  encore surveillée, ce qui donnait l'impression que la feature ne servait qu'à
  se configurer elle-même. Une machine éteinte affiche désormais ce qu'elle est
  et une seule action.
- **Les réglages sont ceux de la coquille commune.** Un onglet de la vue est un
  endroit où l'on va lire ; des réglages sont une action qu'on termine, et il
  n'y a qu'un dialogue pour ça par feature : le bouton Réglages (en-tête de la
  flotte, en-tête d'une machine), ouvert sur l'onglet Appareils, qui liste les
  appareils visibles avec, pour chacun, surveillance, fenêtre d'apprentissage,
  cadence du manifeste, journal d'authentification et réapprentissage. Le
  dialogue maison par appareil derrière un second engrenage a disparu au
  rapatriement (dette de `Docs/SETTINGS.md`). Sentinelle n'a pas d'éléments : ses
  « éléments » sont des appareils, l'échelle élément de la coquille ne
  s'applique pas.
- **Ce qui est long est replié** (ligne de base, décisions) et chargé seulement à
  l'ouverture : cinq cents lignes qu'on ne consulte qu'en cas de doute ne doivent
  pas repousser hors de l'écran ce qu'on est venu voir.

Côté forme, la feature emprunte tout à la DA : cartes en `--surface-widget`
bordées de verre qui se soulèvent au survol (même grammaire que Bases de
données), `StatusBadge` pour les états, `Checkbox`, `SelectInput` et `TextInput`
du projet — jamais les contrôles natifs. Les quatre gravités réutilisent
`--danger` et `--warning` plutôt que d'introduire une échelle chromatique de
plus : un rouge qui ne serait pas celui du reste de l'application se lirait comme
un état différent.

## Le catalogue de règles

`SENTINEL_RULES` (dans `@deveye/types`) est figé : identifiant, gravité par défaut,
libellé, description, **conduite à tenir**, sonde requise, dépendance à la ligne
de base. Un constat sans conduite à tenir ne sert personne, d'où le champ
obligatoire.

Les règles vivent dans `features/sentinel/src/server/rules.ts` et sont
**toutes des fonctions pures** : aucune ne lit la base, n'écrit nulle part, ni
ne regarde l'horloge autrement qu'à travers le `now` qu'on lui passe. C'est
cette pureté qui les rend vérifiables, en leur fabriquant un instant et en
regardant ce qu'elles rendent.

`rules.test.ts` (à côté) leur oppose des instants fabriqués et vérifie ce
qu'elles rendent : 31 vérifications, celles de l'ancien
`scripts/check-rules.ts` de l'app, lancées par `npm run test:features` (donc
par `npm run ci:features`). Ce filet n'est pas décoratif : une règle de
détection qui cesse de se déclencher ne casse rien, ne lève rien, et ne se voit
nulle part. La feature a simplement l'air calme, ce qui est le pire mode de
panne possible pour un détecteur.

Une règle rend un `FindingDraft`, jamais un effet : c'est le moteur qui décide
d'ouvrir, d'incrémenter ou de notifier. Une règle qui saurait cela devrait
connaître l'état précédent, et deviendrait intestable.

## Coût

| Poste                     | Ordre de grandeur                                                            |
| ------------------------- | ---------------------------------------------------------------------------- |
| Ligne de base             | ~830 lignes/appareil, **statique** après apprentissage                       |
| Tick agent                | +2–5 ms (`readlink /proc/<pid>/exe`, ~700 syscalls) sur les ~40 ms existants |
| Relevé de persistance     | ~57 entrées mesurées sur un poste Fedora ; ~50 ms toutes les 6 h             |
| Relevé d'authentification | une fenêtre `journalctl --since`, ~20 ms par heure                           |
| Manifeste sur le fil      | 60–240 Ko par relevé, **jamais stocké brut**                                 |

## Pièges connus

- **`@deveye/types` est miroité, pas symlinké** — voir `features/devices/README.md`.
- **La collation des clés étrangères se déclare.** `devices.id` est en
  `utf8mb4_general_ci` ; un `CHAR(36)` nu hérite de la collation par défaut de la
  base _cible_, `utf8mb4_0900_ai_ci` sur tout MySQL 8 récent. Une FK exige les
  deux identiques : la migration 074 déclare donc la sienne explicitement, sans
  quoi elle passerait ici et échouerait sur une base restaurée ailleurs — au
  démarrage, hors transaction, à moitié appliquée.
- **`occurrences` n'est plus affiché tel quel.** Le compteur reste incrémenté et
  en base, mais l'interface montre une **durée** (`persistedFor`, sur une copie
  de `formatDuration` du Monitoring dans `src/client/format.ts` du module : un
  module n'importe rien de l'app hors du barrel). Pour une condition vraie en permanence le
  nombre n'était que la durée divisée par la cadence de relevé, et « ×300 » se
  lisait comme trois cents problèmes distincts. Le décompte brut survit dans les
  infobulles.
- **Le cache de ligne de base du moteur est en mémoire** et suppose un seul
  processus, comme `lastProcessSampleTs` dans `agent/handlers/telemetry.ts`.
  `sentinel.resetBaseline` appelle `engine().invalidate()` (le singleton posé
  par `createService`, patron `setEngine` de CloudSync), sans quoi la remise à
  zéro n'aurait d'effet qu'au prochain redémarrage du serveur.
- **Les dépôts du module ne joignent pas `devices`.** Constats et autorisations
  rendent `device_id` ; les handlers résolvent les noms par
  `ctx.deveye.devices.list()` (une Map par requête, un appareil disparu ou hors
  périmètre se nomme par son id tronqué). Les clés étrangères des tables
  historiques vers `devices` restent : ce sont des contraintes, pas des
  lectures.
