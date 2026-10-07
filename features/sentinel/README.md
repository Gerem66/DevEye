# Sentinelle : détection d'intrusion sur les appareils

Sentinelle lit ce que l'agent remonte d'une machine (processus, ports,
rapport de posture, manifeste de persistance, issues d'authentification) et en
tire des **constats** : une dérive par rapport à ce qui a été appris, un
comportement suspect, un défaut de configuration. Appareils **collecte**,
Sentinelle **interprète** : rien ici n'ouvre une sonde de son propre chef.

Sentinelle est un module (`features/sentinel/`,
[Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md)). Ses contrats vivent dans
`src/contracts/` (`domain.ts`, `commands.ts`) ; `@deveye/types` ne garde que le
protocole agent (`domain/report.ts`, `protocol/agent.ts`), l'identité de la
feature (id, descripteur, sujet live, émetteur de notifications) et le couplage
déclaré vers l'app (`sdk/providers.ts` : `SENTINEL_AGENT_CONFIG_PROVIDER`,
`DEFAULT_SENTINEL_INTEGRITY_MINUTES`).

À lire avec [Appareils](../devices/README.md), dont les invariants sur la
config poussée à l'agent, le `null` qui veut dire « inconnu », les sondes
best-effort et la garde d'accès unique à un appareil s'appliquent ici tels
quels.

## Ce que Sentinelle ne fait pas

Aucun suivi de l'activité des utilisateurs. La sonde d'authentification remonte
des **issues** (une tentative a réussi ou échoué, depuis quelle adresse, contre
quel compte) et jamais ce que quelqu'un fait de sa session ; la sonde de
persistance remonte des **empreintes** et jamais le contenu d'un fichier.

Ce n'est pas une limitation technique : l'agent a les droits de lire bien
davantage. C'est la frontière de la feature, et elle est appliquée à la
source : `authlog.rs` compte les élévations `sudo` alors que la commande
exécutée est sur la même ligne, et ne l'emporte pas.

## Ce qu'on peut faire croire à Sentinelle, et ce qu'on ne peut pas

Un détecteur d'intrusion lit des traces que l'intrus cherche à fausser. Ce qui
suit dit où passe la limite.

- **Un compte sans privilège ne fabrique pas de constat d'authentification.**
  L'identifiant syslog (`sshd`, `useradd`) est au choix de qui écrit :
  `logger -t sshd "Failed password for root from …"` suffit à le porter. La
  sonde lit donc journald en JSON et ne retient une entrée `sshd` ou `useradd`
  que si `_UID` vaut 0, champ que journald pose lui-même depuis la socket.
  `sudo` écrit sous l'uid de qui l'invoque : on n'en garde que le fait (une
  élévation), jamais le texte, qu'un faux pourrait habiller en échec de
  connexion.
- **Un flot ne rend pas la fenêtre « calme ».** Au plafond de lignes
  (`MAX_LINES`, 20 000), ce sont les plus récentes qui sont comptées, et la
  fenêtre est marquée `truncated` : les règles l'écrivent dans la preuve
  (« compteurs minorés ») plutôt que de laisser un chiffre partiel passer pour
  exact.
- **Un journal illisible n'est pas un journal vide** : `unavailable`, et aucune
  règle ne conclut.
- **Le repli sur `/var/log/auth.log` et `/var/log/secure` n'a pas cette
  garantie.** Sans journald, le fichier ne dit pas qui a écrit une ligne ; sur
  une machine où un compte ordinaire peut y écrire, un faux passe. C'est le cas
  rare, et il est connu.
- **Root local peut tout.** Effacer le journal, réécrire le manifeste de
  persistance, tuer l'agent, installer un paquet dont le fichier passera pour
  « livré par le paquet » : rien de ce qu'un agent lit sur une machine ne vaut
  contre qui la possède déjà. Sentinelle voit l'arrivée, pas l'occupant
  installé.

## Trois notions, à ne pas confondre

|                   | Quoi                                               | Où                   | Reconstructible ?              |
| ----------------- | -------------------------------------------------- | -------------------- | ------------------------------ |
| **Ligne de base** | ce qui a été _observé_ : des faits, sans jugement  | `device_baseline`    | oui (`sentinel.resetBaseline`) |
| **Constat**       | un écart _jugé_ digne d'être montré                | `device_findings`    | non, c'est une preuve          |
| **Autorisation**  | une décision _humaine_ : « ceci est légitime ici » | `sentinel_allowlist` | **jamais**                     |

Les autorisations sont rangées à part de la ligne de base, et c'est le point le
plus important du schéma. Les mélanger ferait redemander à l'utilisateur,
machine par machine, de rejuger ce qu'il avait déjà jugé après chaque montée de
version d'agent : la façon la plus sûre de faire abandonner la feature. Une
autorisation a une portée : cet appareil (`device`) ou toute la flotte de
l'espace (`fleet`).

Un constat porte une gravité (`info`, `low`, `high`, `critical`), un état
(`open`, `acknowledged`, `resolved`), un sujet, une preuve (`evidence`), ses
première et dernière occurrences, et l'instant de télémétrie qui le porte
(`snapshot_ts`).

## Les flux

| Flux                 | Cadence (défaut)                  | Contenu                                                                                | Stockage                      |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| **Instant**          | 60 s (300 s sur l'offre gratuite) | réutilise `metrics.batch` : processus (nom, **chemin**, compte, ports, connexions)     | déjà en base                  |
| **Rapport**          | 1 h                               | réutilise `agent.report` : posture étendue (sshd, MAC, reboot, correctifs de sécurité) | `devices.report_json`         |
| **Persistance**      | 6 h (+ connexion, + `agent.scan`) | empreintes SHA-256 des surfaces d'installation au démarrage, et leur verdict de paquet | **diffé, jamais stocké brut** |
| **Authentification** | 1 h                               | compteurs + ≤50 adresses + ≤50 connexions                                              | **conclusions seules**        |

La cadence de l'instant est celle de la télémétrie d'Appareils
(`DEFAULT_METRIC_INTERVAL_SECONDS` : 60 s payé, 300 s gratuit). Celle de la
persistance se règle par appareil, de 15 min à 24 h.

Réglages par appareil : `ft_sentinel_device_config` (`device_id`, `enabled`,
`learning_until`, `integrity_minutes`, `auth_events`, `pin_evidence`,
`last_integrity_at` ; une ligne par appareil surveillé ou l'ayant été ;
l'absence de ligne vaut « sondes éteintes, défauts » ; `ON DELETE CASCADE` avec
l'appareil), poussés à l'agent par `agent.config` et **rejoués à la
reconnexion**. Le moteur y tient aussi son horloge d'activité
(`snapshot_ticks`) et le format du dernier manifeste appris
(`persistence_format`). C'est l'app qui compose cette config (`agentConfigFor`,
`src/agent/config.ts`), en demandant au module sa part par
`SENTINEL_AGENT_CONFIG_PROVIDER` : sans module installé, ou sans ligne pour
l'appareil, les sondes sont éteintes. La table est créée par le socle
(`098_sentinel_device_config.sql`) et possédée par le module, qui la démonte
(`uninstall.sql`) et la complète (`migrations/`).

### Le travail de connexion est borné des deux côtés

Rapport et relevés partent **aussi** à la connexion, pour qu'une machine qu'on
vient d'allumer rende son état sans attendre son premier tour d'horloge. Une
machine qui se **reconnecte en boucle** les rejouerait alors autant de fois, et
un constat `port.*` ou `posture.*` de cadence horaire se compterait des
centaines de fois en quelques heures, pour un travail qui empreinte des
centaines de fichiers et lit des journaux. Deux gardes, délibérément aux deux
bouts :

- **Agent** (`runner.rs`) : `ConnectMarks` retient quand chaque travail a été
  fait pour la dernière fois, **au-delà de la session** pour survivre à une
  reconnexion ; `due_at` décide. `MIN_CONNECT_WORK_GAP` vaut 15 min pour le
  rapport et le relevé de persistance, `MIN_CONNECT_SNAPSHOT_GAP` 60 s pour
  l'instant, contre une cadence nominale d'une heure. Au lancement du processus
  les jalons sont `None`, donc un vrai démarrage ne perd rien. Les tickers
  **posent** le jalon eux aussi, sinon un tour d'horloge suivi d'une
  reconnexion serait immédiatement rejoué. `agent.collect` et `agent.scan` ne
  sont jamais bornés : ce sont des ordres explicites.
- **Serveur** (`src/server/engine.ts`) : `EVAL_FLOOR_MS` (10 min) plafonne la
  réévaluation de `report` / `auth` / `integrity` par appareil. Nécessaire _en
  plus_ du garde agent, pour deux raisons : la flotte se met à jour à son
  rythme, et un `Instant` est relatif au processus, donc un agent qui plante en
  boucle repart sans mémoire. L'ingestion n'est pas touchée (`report_json`,
  les ports et la ligne de base s'écrivent) ; seule la relecture des règles est
  bornée.

Sauter une évaluation saute **aussi** son entrée dans `replayed` : annoncer une
famille rejouée sans lui fournir de constats la ferait résoudre en bloc, le
détecteur qui s'éteint sans bruit de l'invariant 16.

Ces gardes rendent le symptôme invisible, donc le hub des agents **signale**
les rafales de reconnexion (`noteReconnect`, `src/agent/hub.ts`, au-delà de 12
connexions par heure et par appareil). Les taire sans le dire remplacerait un
défaut voyant par un défaut muet.

## Invariants

1. **L'ingestion n'évalue pas.** Un lot de métriques peut porter cent instants
   (agent revenu après une coupure). Les handlers d'agent de l'app
   (`src/agent/handlers/telemetry.ts`, `security.ts`) persistent, puis tendent
   ce qu'ils ont persisté aux hooks des modules (`onReport`, `onMetricsBatch`,
   `onIntegrity`, `onAuthEvents`) pour tout appareil **actif** ; les hooks du
   module relisent sa config (surveillé ? sonde d'auth allumée ?) et se
   contentent d'`enqueue*()` ; le moteur draine à son tour de boucle
   (`SENTINEL_TICK_SECONDS`), **ne garde que le dernier instant par appareil**,
   et évalue. → Ne jamais appeler une règle depuis un hook ni depuis
   `src/agent/handlers/`.

2. **La fenêtre d'apprentissage n'est pas négociable.** Pendant qu'elle court
   (`ft_sentinel_device_config.learning_until`, 7 j par défaut), tout est
   absorbé dans la ligne de base et les règles de dérive se taisent. Sans elle,
   le premier jour produirait des centaines de constats « nouveau programme »
   et la liste serait illisible avant d'avoir servi. Les règles qui n'en
   dépendent pas (`exec.*`, `net.*`, `posture.*`, `auth.*`) restent actives :
   un binaire dans `/tmp` est anormal le jour 1 comme le jour 100. → Le moteur
   pose `ctx.learning`, que chaque famille de règles de dérive teste ;
   `SENTINEL_RULES[...].needsBaseline` documente la même distinction dans le
   catalogue, et l'interface s'en sert pour dire « muette pendant
   l'apprentissage ».

3. **La ligne de base se fusionne, jamais ne se remplace.** `baseline.observe()`
   réécrit `attrs` en bloc ; c'est au moteur d'unir comptes et ports avec ce qui
   est connu avant d'écrire. Sans cela, un programme tournant sous deux comptes
   déclencherait `process.user_changed` à chaque alternance, et l'enveloppe
   CPU serait recalculée depuis une seule mesure. → Voir `observeSnapshot`.

4. **Elle s'écrit après l'évaluation.** L'inverse ferait qu'un programme
   nouveau serait déjà connu au moment où l'on se demande s'il est nouveau, et
   `process.new` ne se déclencherait jamais.

5. **La clé d'un programme est `(nom, chemin)`.** Agréger sur le seul nom
   fusionnerait deux binaires homonymes rangés à des endroits différents,
   exactement ce derrière quoi un imposteur se cache. → Après une montée de
   version d'agent qui change ce qui est observé, lancer
   `sentinel.resetBaseline` (les autorisations survivent).

6. **`null` = pas mesuré, jamais « tout va bien ».** Un contrôle de posture dont
   la sonde n'a rien dit vaut `unknown` et **ne compte pas dans le score** ; le
   diluer récompenserait une machine qui ne mesure rien. Une règle dont la
   sonde est absente ne se déclenche pas « à vide ». `report.agent.probes` dit
   ce que l'agent **sait faire**, ce qui distingue « la sonde a échoué ici »
   d'« agent trop ancien » : les deux rendent `null`, mais l'un envoie
   inspecter la machine et l'autre la mettre à jour. → Ajouter une sonde, c'est
   ajouter son nom à `PROBES` dans `report.rs`.

7. **Notifier aux transitions seulement, et grouper.** `device_findings.state`
   porte l'état courant. Seul un constat qui vient de s'ouvrir notifie, à
   partir de `high` (`SENTINEL_NOTIFY_FROM`), et les constats d'un même
   appareil dans un même tour partent en **un seul message**, titré par la
   règle du plus grave : une machine compromise déclenche vingt règles d'un
   coup, et vingt mails ne se lisent pas. **Ses propres canaux**, et rien
   d'emprunté : le mécanisme est commun (les canaux et les routes de l'espace,
   [Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md)), la configuration ne
   l'est pas. Sentinelle a sa propre route, éteinte par défaut : emprunter un
   canal désigné pour la disponibilité reviendrait à écrire à des gens sans le
   leur avoir demandé.

8. **Acquitter écrit une autorisation, dans cet ordre.** L'autorisation
   d'abord, la résolution ensuite : si l'écriture échoue, le constat reste
   ouvert plutôt que de disparaître sans que rien n'empêche son retour. Rouvrir
   retire l'autorisation, sinon le moteur refiltrerait le constat au tour
   suivant et la réouverture s'annulerait toute seule.

    Corollaire d'interface : les décisions restent **visibles et révocables**
    (section « Décisions »). Sans cet écran, acquitter serait un aller sans
    retour, et une décision d'un jour deviendrait un angle mort permanent.

    **« Réglé » n'est pas « légitime », et les deux sorties existent.** Le
    moteur ne résout de lui-même que ce qu'il sait rejouer (`SNAPSHOT_RULES`,
    `REPORT_RULES`, via `resolveMissing`) : un constat d'événement (`auth.*`,
    `persistence.*`) décrit un fait passé, donc plus aucun relevé ne cessera de
    le porter, et il resterait ouvert indéfiniment même après correction.
    `sentinel.resolve` le ferme **sans écrire d'autorisation** : il rouvrira au
    premier relevé qui le revoit, là où un acquittement l'aurait fait taire pour
    toujours. N'offrir que l'acquittement ferait déclarer normal ce qui vient
    d'être corrigé, et empoisonnerait l'allowlist, le seul état que rien ne
    reconstruit.

9. **Un constat ≥ `high` épingle son instant.** Via `telemetry.pinInstant` de
   la façade du SDK, qui traite les deux tables de télémétrie en une
   instruction. Sans cela la rétention effacerait la seule liste de processus
   qui explique le constat. Les constats eux-mêmes ne suivent pas la rétention
   de la télémétrie : ce sont des preuves. Seuls les `resolved` sont balayés,
   après `SENTINEL_FINDING_RETENTION_DAYS` (180 j) ; les ouverts jamais.

    Refusable par appareil (`pin_evidence`, actif par défaut, libellé « Garder
    l'instant qui prouve un constat sérieux » dans l'onglet Appareils) : ces
    instants gardés apparaissent dans l'historique d'Appareils, et une feature
    qui pose des relevés durables chez une autre doit pouvoir se laisser refuser
    depuis ses propres réglages.

10. **« Binaire supprimé » veut dire « plus rien à ce chemin ».** Le noyau
    suffixe `/proc/<pid>/exe` de « (deleted) » pour deux situations opposées :
    l'exécutable a disparu (implant résident, ce qu'on cherche) ou il a été
    **remplacé**, ce que fait tout gestionnaire de paquets par un `rename()`
    par-dessus. Le discriminant est le chemin : s'il pointe encore sur un
    fichier, le binaire a été remplacé ; sans lui, chaque mise à jour de
    paquets ferait sonner en `critical` la moitié des processus au long cours
    d'un serveur. → Voir `proc_exe` dans `report.rs` et son test.

11. **Un fil du noyau n'entre pas dans la ligne de base.** Son nom encode un
    CPU et un index que le noyau recycle en continu (`kworker/6:0H-kblockd`,
    `jbd2/nvme1n1p1-8`) : chacun franchirait les seuils de `process.vanished`
    puis s'évaporerait sans jamais se résoudre, des centaines de constats
    ouverts pour un phénomène qui n'est pas un événement. Le discriminant est
    `PF_KTHREAD`, que l'agent lit dans `/proc/<pid>/stat` et remonte en
    `kernel` ; le nom ne sert que de repli, et seulement à défaut de chemin
    (`isKernelThread`). Un nom de fil du noyau porté par un binaire du disque
    reste ce que `exec.masquerade` cherche.

12. **Un manifeste tronqué ne prouve aucune suppression.** `truncated` coupe
    `persistence.removed` **et** l'oubli en ligne de base : il ne dit pas
    qu'une entrée a disparu, seulement qu'on a cessé de regarder.

    **On ne compare que des manifestes de même format.** L'agent dit comment
    il empreinte (`format`, `MANIFEST_FORMAT` dans `integrity.rs`) ; un
    manifeste d'un autre format que celui de la ligne de base s'apprend sans
    constat, sinon un agent mis à jour ferait passer chaque entrée pour
    modifiée. → Changer la façon d'empreinter, c'est monter `MANIFEST_FORMAT`.

    **Un fichier livré tel quel par son paquet n'est ni ajouté ni modifié.**
    L'agent compare chaque fichier à la base de son gestionnaire de paquets
    (empreinte SHA-256 de rpm, MD5 de dpkg) et le dit dans `vendor` : un
    `/etc/profile.d` réécrit par une mise à jour n'est pas un geste. Un lien
    n'est jamais vérifié ainsi : un lien vers `/usr` s'empreinte par sa
    cible, et activer un service reste un ajout. Windows rend une entrée par
    valeur de `Run`/`RunOnce` et par tâche planifiée, empreintée sur sa seule
    définition (ni état, ni prochaine exécution).

13. **Éteint par défaut, appareil par appareil.** Activer Sentinelle est un
    geste explicite : c'est lui qui autorise la lecture des journaux
    d'authentification, et cela ne doit pas arriver par effet de bord de
    l'ouverture d'une feature. La sonde d'auth a son propre interrupteur sous
    celui de la feature.

14. **Rien n'est chiffré.** Ce sont des faits sur des machines, même palier que
    `devices.report_json`. C'est ce qui laisse le moteur tourner **sans session
    ni mot de passe**, sans le détour par le chiffre ouvert qu'impose Uptime
    ([Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md)). → Ne pas y ranger
    de secret d'utilisateur.

15. **Le séparateur des clés composées est un NUL (`\u0000`),** déclaré une fois
    (`KEY_SEP` dans `src/server/repo.ts`) et lu par `allowSubject()`. Un NUL
    plutôt qu'un espace parce qu'un sujet est souvent un chemin ; écrit en
    échappement parce qu'un octet invisible en source disparaît au premier
    copier-coller, et le perdre changerait **toutes** les empreintes de
    dédoublonnage d'un coup. → Ne jamais le retaper à la main ailleurs.

16. **Une règle ne se rejoue qu'à la cadence de ce qui la nourrit.** Chaque flux
    a la sienne (tableau plus haut) : l'instant toutes les 60 s, le rapport
    toutes les heures. `evaluateSnapshot` ne prend que ce qui lit
    `ctx.snapshot`, `evaluateReport` ce qui lit `ctx.report` ; persistance et
    authentification arrivent sur leurs propres relevés. Chaque famille a son
    jeu de règles résolubles (`SNAPSHOT_RULES` / `REPORT_RULES`), et `record()`
    ne résout que celles qu'on vient effectivement de rejouer.

    **C'est la source qui range une règle, pas son préfixe.** `net.mining_pool`
    est une règle de rapport : les connexions établies vivent dans
    `report.connections`, l'instant ne porte que le compteur
    `activeConnections`. En cas de doute, la question n'est pas « de quoi ça
    parle » mais « qu'est-ce que la fonction lit dans `ctx` ».

    Ranger une règle de rapport dans la famille de l'instant aurait deux
    effets : un constat se re-constaterait chaque minute sur un rapport
    inchangé (`occurrences` compterait des tours de moteur et `last_seen`
    annoncerait « il y a 5 min » un fait mesuré jusqu'à une heure plus tôt), et
    un rapport arrivé sans instant résoudrait d'un coup tous les `exec.*` /
    `net.*` / `process.*`, les règles rendant `[]` faute de `ctx.snapshot` et
    `resolveMissing` prenant ce silence pour une disparition. Un détecteur qui
    s'éteint sans bruit, exactement le mode de panne contre lequel
    `rules.test.ts` est le seul filet (section « Séparation des cadences »).

17. **Un port dynamique se range sous son programme.** Au-dessus de
    `EPHEMERAL_PORT_FLOOR` (32768), le système choisit le port à chaque
    lancement, et une socket UDP cliente, celle d'un navigateur, apparaît
    comme une écoute sur toutes les interfaces. La clé d'écoute devient
    `udp/*:dynamique|firefox` (`listenerKey`), pour la règle comme pour la
    ligne de base : un programme qui fait cela s'apprend une fois, un nouveau
    programme qui le fait sonne une fois, et la preuve liste ses ports.

### La passe lente

Une fois par heure (`SLOW_PASS_MS`), le moteur décide ce qui ne se décide pas
sur un instant, pour chaque appareil surveillé, actif et sorti
d'apprentissage.

Les durées s'y comptent en **temps d'activité de la machine**, pas à
l'horloge : `snapshot_ticks` avance d'un cran par instant évalué non vide, et
chaque programme de la ligne de base retient le cran de son dernier passage
(`lastTick`) et sa série d'instants consécutifs (`streak`). Une machine
éteinte, un agent coupé ou une sonde de processus en panne n'avancent pas le
compteur : rien ne disparaît pendant qu'on ne regarde pas. Mesurée à
l'horloge, une nuit d'arrêt ferait « disparaître » tout ce qui tournait.

- **`process.vanished`** : un programme absent depuis une heure d'activité
  (`VANISHED_AFTER_MS`, dix instants au moins) après une présence
  ininterrompue de trois jours d'activité (`VANISHED_MIN_STREAK_MS`) est
  déclaré disparu. La série distingue un service d'un programme qu'on ouvre
  et ferme : fermer un navigateur ou un jeu n'est pas un événement. La ligne
  reste dans la ligne de base, et la passe rejoue toute la famille : au
  retour du programme, il est connu (pas de « nouveau programme ») et son
  constat se ferme.
- **L'oubli** : un programme absent depuis trente jours d'activité
  (`BASELINE_FORGET_MS`) sort de la ligne de base, et son constat de
  disparition se ferme avec lui. Oublier trop tôt ferait sonner `process.new`
  à chaque exécution d'un programme intermittent, une sauvegarde nocturne ou
  un gestionnaire de paquets.
- **Le balayage** des constats résolus plus vieux que
  `SENTINEL_FINDING_RETENTION_DAYS`.

## L'interface : deux niveaux, aucun onglet

On entre par **la flotte** (qu'est-ce qui ne va pas, et où) et on descend sur
**une machine**, qui se lit d'une seule traite : ses constats, sa posture, ce
qu'on a appris d'elle, les décisions prises à son sujet. Ces quatre choses ne
s'excluent pas, elles se lisent **ensemble et dans cet ordre** : on regarde les
constats et on se demande aussitôt si la configuration les explique. Des
onglets les sépareraient à tort.

Trois règles en découlent :

- **Cliquer le nom d'une machine ouvre sa lecture, jamais un formulaire.** Une
  machine non surveillée affiche ce qu'elle est et une seule action.
- **Les réglages sont ceux de la coquille commune.** Un onglet de la vue est un
  endroit où l'on va lire ; des réglages sont une action qu'on termine, et il
  n'y a qu'un dialogue pour ça par feature : le bouton Réglages (en-tête de la
  flotte, en-tête d'une machine), ouvert sur l'onglet **Appareils**
  (`SentinelDevicesPanel`, déclaré par `settings.feature` du manifest). Pour
  chaque appareil visible : l'interrupteur « Surveiller « nom » », la
  « Fenêtre d'apprentissage à l'activation » (1, 3, 7, 14 ou 30 jours), le
  « Relevé de persistance » (toutes les heures, toutes les 3 heures, toutes les
  6 heures, deux fois par jour, une fois par jour), « Relever les issues
  d'authentification », « Garder l'instant qui prouve un constat sérieux » et
  « Réapprendre » (`sentinel.resetBaseline`). Sentinelle n'a pas d'éléments :
  ses « éléments » sont des appareils, l'échelle élément de la coquille ne
  s'applique pas.
- **Ce qui est long est replié** (ligne de base, décisions) et chargé seulement
  à l'ouverture : cinq cents lignes qu'on ne consulte qu'en cas de doute ne
  doivent pas repousser hors de l'écran ce qu'on est venu voir.

Le détail d'un constat (`FindingDetail`) dit ce qui a été vu, ce que ça veut
dire, quoi faire, et offre les deux sorties : acquitter (cette machine, ou
partout) et « c'est réglé ».

Les constats d'une même règle sur un même appareil, dans le même état, ne
font qu'une ligne (`groupFindings`) : elle se déplie sur ses sujets, chacun
ouvrant son constat, et son détail (`FindingGroupDetail`) offre les mêmes
deux sorties pour tout le groupe d'un geste. Vingt fichiers réécrits par une
mise à jour se jugent une fois, pas vingt. `sentinel.acknowledge` et
`sentinel.resolve` prennent donc une liste de constats, vérifiée en entier
avant la première écriture ; le bloc d'actions (`FindingActions`) est le même
pour un constat et pour un groupe. La posture (`PostureGrid`) montre chaque contrôle
dans l'un de quatre états : conforme, à corriger, non mesuré, sans objet ; les
contrôles à corriger remontent en tête. L'en-tête d'une machine affiche les
sondes manquantes plutôt que de les taire : une machine non regardée sur un
point n'a pas « rien à se reprocher ».

Côté forme, la feature emprunte tout à la direction artistique : cartes en
`--surface-widget` bordées de verre (`--glass-border`) qui se soulèvent au
survol, `StatusBadge` pour les états, `Checkbox`, `SearchSelect` et `TextInput`
du SDK, jamais les contrôles natifs. Les gravités réutilisent `--danger` et
`--warning` plutôt que d'introduire une échelle chromatique de plus : un rouge
qui ne serait pas celui du reste de l'application se lirait comme un état
différent.

## Le catalogue de règles

`SENTINEL_RULES` (`src/contracts/domain.ts`) est figé : identifiant, gravité
par défaut, libellé, description, **conduite à tenir**, sonde requise
(`snapshot`, `report`, `execPath`, `posture`, `integrity`, `auth`), dépendance
à la ligne de base. Un constat sans conduite à tenir ne sert personne, d'où le
champ obligatoire. Le catalogue est typé `Record<SentinelRuleId, …>` : une
règle du schéma sans métadonnée ne compile pas. Les familles :

- **dérive de la ligne de base** (muettes pendant l'apprentissage) :
  `process.new`, `process.user_changed`, `process.new_listener`,
  `process.resource_anomaly`, `process.vanished`, `port.exposed`,
  `port.unattributed` ;
- **heuristiques d'instant**, actives tout de suite : `net.mining_pool`,
  `net.shell_outbound`, `net.connection_spike`, `exec.suspicious_path`,
  `exec.deleted_binary`, `exec.masquerade` ;
- **diff du manifeste de persistance** : `persistence.added`,
  `persistence.modified`, `persistence.removed` ;
- **issues d'authentification** : `auth.bruteforce`,
  `auth.success_after_failures`, `auth.new_account`, `auth.root_login` ;
- **posture** (un défaut de configuration est un constat comme un autre, avec
  le même cycle de vie et le même chemin de notification) :
  `posture.firewall_off`, `posture.disk_unencrypted`, `posture.sip_off`,
  `posture.updates_stale`, `posture.ssh_root_login`,
  `posture.ssh_password_auth`, `posture.no_mac`, `posture.reboot_pending`.

Les règles vivent dans `src/server/rules.ts` et sont **toutes des fonctions
pures** : aucune ne lit la base, n'écrit nulle part, ni ne regarde l'horloge
autrement qu'à travers le `now` qu'on lui passe. C'est cette pureté qui les
rend vérifiables, en leur fabriquant un instant et en regardant ce qu'elles
rendent. `rules.test.ts` (à côté) leur oppose des instants fabriqués, par
`npm run test:features`. Ce filet n'est pas décoratif : une règle de détection
qui cesse de se déclencher ne casse rien, ne lève rien, et ne se voit nulle
part. La feature a simplement l'air calme, ce qui est le pire mode de panne
possible pour un détecteur.

Une règle rend un `FindingDraft`, jamais un effet : c'est le moteur qui décide
d'ouvrir, d'incrémenter ou de notifier. Une règle qui saurait cela devrait
connaître l'état précédent, et deviendrait intestable.

## Carte du code

### Le module : `features/sentinel/`

| Où                                    | Quoi                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deveye-feature.json`, `package.json` | `deveye-feature-sentinel` ; allowlist des trois tables du socle                                                                                                                                                                                                                                                                                       |
| `src/manifest.ts`                     | `featureDescriptor('sentinel')` étalé ; resources, capacités (`devices.read`, `telemetry.read`, `agents`, `notify`), onglet Appareils                                                                                                                                                                                                                 |
| `src/contracts/domain.ts`             | gravités, états, `SENTINEL_RULES` et le schéma des identifiants, ligne de base, constat, autorisation, posture, config par appareil, bornes et défauts                                                                                                                                                                                                |
| `src/contracts/commands.ts`           | les treize commandes `sentinel.*`                                                                                                                                                                                                                                                                                                                     |
| `src/server/engine.ts`                | le moteur : file d'ingestion, évaluation par tour, ligne de base en mémoire, plancher d'évaluation, passe lente, notifications groupées, `live.changed` ; ses hooks agent                                                                                                                                                                             |
| `src/server/rules.ts`                 | le catalogue de règles, fonctions pures ; `SNAPSHOT_RULES`, `REPORT_RULES`                                                                                                                                                                                                                                                                            |
| `src/server/repo.ts`                  | ligne de base, constats, autorisations, config par appareil (`deviceConfig`) ; `KEY_SEP`                                                                                                                                                                                                                                                              |
| `src/server/handlers.ts`              | les treize commandes ; `_shared.ts` la posture, les DTO, les noms d'appareils, le singleton du moteur                                                                                                                                                                                                                                                 |
| `src/server/notice.ts`                | la mise en page Discord d'un constat                                                                                                                                                                                                                                                                                                                  |
| `src/server/env.ts`                   | `SENTINEL_TICK_SECONDS`, `SENTINEL_LEARNING_DAYS`, `SENTINEL_FINDING_RETENTION_DAYS`                                                                                                                                                                                                                                                                  |
| `src/server/index.ts`                 | `serverEntry` : env, createRepo, features, accountExport, migrationsDir, createService (moteur, hooks agent, `SENTINEL_AGENT_CONFIG_PROVIDER`)                                                                                                                                                                                                        |
| `src/server/accountExport.ts`         | l'export des données du compte, table par table                                                                                                                                                                                                                                                                                                       |
| `src/server/migrations/`              | `001` la colonne `pin_evidence`, `002` l'horloge d'activité, le format du manifeste et le repli des ports dynamiques                                                                                                                                                                                                                                  |
| `src/server/uninstall.sql`            | démonte `ft_sentinel_device_config`, la seule table du module au préfixe                                                                                                                                                                                                                                                                              |
| `src/server/*.test.ts`                | rules, engine, handlers, notice, accountExport                                                                                                                                                                                                                                                                                                        |
| `src/client/`                         | `Sentinel.tsx` (la vue), `FleetHeader`, `DeviceHeader`, `FindingsList` (et `persistedFor`, `groupFindings`), `FindingDetail`, `FindingGroupDetail`, `FindingActions`, `PostureGrid`, `BaselineSection`, `AllowlistSection`, `SentinelWidget` (la carte), `SentinelDevicesPanel` (l'onglet Appareils), `store.ts` (le décompte), `format.ts`, `api.ts` |

### Ce que l'app garde

- `src/agent/handlers/telemetry.ts`, `security.ts` : les handlers agent, qui
  persistent puis tendent la télémétrie aux hooks des modules sans rien garder
  des réglages de Sentinelle ;
- `src/agent/config.ts` (`agentConfigFor`), qui recompose la config poussée à
  l'agent (`agent.config`) avec la part du module ; `src/agent/cadence.ts`
  pour la cadence de l'instant selon l'offre ;
- `src/agent/hub.ts` (`noteReconnect`) ;
- la façade du SDK (`devices`, `telemetry`, `agents`, `notify`), seul chemin du
  module vers les appareils, les instants et la flotte ;
- les migrations du socle : `074_sentinel.sql` (les trois tables),
  `098_sentinel_device_config.sql` (la config par appareil),
  `133_pin_collation.sql` (la collation de toutes ces tables).

### L'agent (`agent/src/`)

`runner.rs` (les cadences, `ConnectMarks`), `authlog.rs` (la fenêtre
d'authentification), `integrity.rs` (le manifeste de persistance,
`MANIFEST_FORMAT`, la vérification par rpm ou dpkg), `report.rs` (le rapport,
`PROBES`, `proc_exe`), `protocol.rs` (le drapeau `kernel`). Le protocole est dans `protocol/agent.ts`
de `@deveye/types` (`metrics.batch`, `agent.report`, `agent.config`,
`agent.scan`, `agent.collect`).

## Configuration

Lues par le module lui-même (`src/server/env.ts`, `defineModuleEnv`), pas par
`Utils/Env` :

| Variable                          | Défaut | Rôle                                                                                  |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `SENTINEL_TICK_SECONDS`           | `60`   | la cadence à laquelle le moteur vide sa file (l'ingestion n'évalue rien, elle empile) |
| `SENTINEL_LEARNING_DAYS`          | `7`    | la fenêtre d'apprentissage par défaut, en jours                                       |
| `SENTINEL_FINDING_RETENTION_DAYS` | `180`  | combien de jours un constat **résolu** est conservé ; les ouverts jamais balayés      |

## Les quotas de l'offre

Sentinelle ne déclare aucun quota : ce qu'elle coûte, c'est la télémétrie des
appareils, bornée en amont par `devices.agents` (le nombre d'appareils actifs,
`DevEye-Billing/src/server/plans.ts`) et par la cadence de l'instant selon
l'offre. Une installation sans module de facturation n'a aucune limite.

## Notifications

`notifies: true` dans le registre : chaque nouveau constat à partir de `high`
part sur les canaux désignés par la route de Sentinelle, groupé par appareil et
par tour (invariant 7), avec l'embed de `notice.ts` pour Discord et un corps en
clair pour le mail et les webhooks (`event: 'sentinel_finding'`). Chaque
constat ouvert est aussi journalisé dans les logs d'audit sous l'identifiant de
sa règle, attribué au propriétaire de l'appareil (le moteur tourne sans
session), comme chaque geste humain (`sentinel.acknowledge`, `sentinel.resolve`,
`sentinel.reopen`, `sentinel.removeAllow`, `sentinel.setConfig`,
`sentinel.resetBaseline`).

## Partage

`shareTier: 'never'`, `hasItems: false` : Sentinelle n'a pas d'éléments et ne
se partage pas. Son périmètre est celui des appareils que l'espace voit
(`ctx.deveye.devices.list()`), et l'accès à un appareil passe par
`ctx.deveye.devices.authorize`.

## Pièges connus

- **La collation des clés étrangères.** `device_id` suit la collation de
  `devices.id` ; la migration `133` épingle toutes ces tables en
  `utf8mb4_general_ci`, pour qu'une base restaurée sur un MySQL dont le défaut
  est `utf8mb4_0900_ai_ci` accepte les mêmes clés étrangères.
- **`occurrences` n'est pas affiché tel quel.** Le compteur reste incrémenté et
  en base, mais l'interface montre une **durée** (`persistedFor` dans
  `src/client/FindingsList.tsx`, sur `formatDuration` de `src/client/format.ts`,
  copie de celle d'Appareils : un module n'importe rien de l'app hors du
  barrel). Pour une condition vraie en permanence le nombre n'est que la durée
  divisée par la cadence de relevé, et un grand compteur se lirait comme autant
  de problèmes distincts. Le décompte brut survit dans les infobulles.
- **Le cache de ligne de base du moteur est en mémoire** et suppose un seul
  processus. `sentinel.resetBaseline` appelle `engine().invalidate()` (le
  singleton posé par `createService`), sans quoi la remise à zéro n'aurait
  d'effet qu'au prochain redémarrage du serveur.
- **Les dépôts du module ne joignent pas `devices`.** Constats et autorisations
  rendent `device_id` ; les handlers résolvent les noms par
  `ctx.deveye.devices.list()` (une Map par requête, un appareil disparu ou hors
  périmètre se nomme par son id tronqué). Les clés étrangères des tables du
  socle vers `devices` restent : ce sont des contraintes, pas des lectures.

## Tests

```bash
cd DevEye
npm run test:features
```
