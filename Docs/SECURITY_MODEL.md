# Modèle de sécurité de DevEye

Référence des mécanismes de chiffrement et d'authentification de l'app. À garder
à jour quand ces flux changent.

## Ce que le serveur peut lire, en une phrase

Tout est chiffré au repos, sous une clé par utilisateur. Par défaut, le serveur
détient de quoi déballer cette clé : il lit. Quand l'utilisateur active le
**chiffrement par mot de passe**, l'étage gardé ne s'ouvre plus qu'avec son mot
de passe vivant : le serveur ne lit plus. L'étage ouvert (ce qu'une tâche de
fond doit servir sans personne devant l'écran : Uptime, intégrations, CloudSync)
reste lisible par un serveur vivant, quoi qu'il arrive. « Zero-knowledge » est
donc une propriété que l'utilisateur obtient sur l'étage gardé, pas l'état par
défaut de l'installation ; toute phrase de vitrine qui le promet sans cette
condition est fausse.

## Chiffrement par enveloppe ("envelope encryption")

Système central de chiffrement des données de features (notes, mots de passe…).
Implémenté par `src/Services/SecretKeyService.ts` + `src/Services/SecureStore.ts`,
décrit côté types dans `DevEye-Types/src/domain/secrecy.ts`.

- Chaque utilisateur possède une **DEK** (Data Encryption Key) aléatoire de 32
  octets, unique par user, créée à la première écriture chiffrée (`ensureRow`).
- La DEK chiffre **toutes** les données de features en **AES-256-GCM**.
- La DEK n'est **jamais** stockée en clair. Elle est _emballée_ (wrapped) selon
  le `wrap_mode` de la ligne `user_secret_keys` :
    - **`server`** → emballée par la clé serveur (dérivée de l'env). C'est le cas
      quand la feature **"Chiffrement par mot de passe" est OFF**. Le serveur peut
      déballer seul → aucune saisie de mot de passe n'est requise pour lire/écrire.
    - **`password`** → emballée par une clé dérivée du mot de passe via
      **Argon2id** (profil versionné par ligne, `KDF_VERSIONS` : une ligne dérivée
      sous un ancien profil se ré-emballe sous le courant au déverrouillage
      suivant, sans migration). Le serveur ne peut alors plus lire les données
      sans le mot de passe vivant. Limite à connaître : activer le chiffrement ne fait pas
      tourner la DEK. Une sauvegarde de la base antérieure à l'activation contient
      encore `dek_wrapped` sous la clé serveur, et cette DEK est toujours celle
      du contenu : qui détient ce dump **et** `CRYPT_KEY_A/B` lit tout ce qui
      sera écrit après. Choix assumé (faire tourner la DEK voudrait dire
      re-chiffrer tout le contenu) ; qui veut ce cran de plus active la feature
      avant d'écrire quoi que ce soit de sensible, ou fait tourner la clé serveur
      ensuite (`KEY_ROTATION.md`).
- Activer/désactiver la feature ou changer de mot de passe **ne réécrit jamais**
  le contenu chiffré : on ré-emballe seulement la DEK.
- Un **code de récupération** optionnel peut aussi déballer la DEK (filet de
  sécurité), stocké dans `recovery_wrapped`.

**Conséquence importante :** rien n'est jamais stocké en clair en BDD. Même
feature OFF, les données sont chiffrées (DEK distincte par user) ; seul le niveau
d'emballage de la DEK change.

**Une primitive, deux formats de blob** (`src/Services/Encryption.ts`), tous
deux AES-256-GCM. Sous une DEK ou une WDK (le contenu, et l'emballage d'une DEK
par une clé dérivée du mot de passe) : base64 de `iv(12) | tag(16) | chiffré`.
Sous la clé serveur (`crypt.sealFor` : l'emballage des DEK, le secret TOTP, le
matériel de clé des modules) : base64 de `0x02 | iv | tag | chiffré`, sous une
**sous-clé par usage** (HKDF de la racine, l'étiquette en `info`) et avec la
**ligne en contexte** (AAD). Un blob scellé pour un usage ne s'ouvre pas pour un
autre, et recopié sur la ligne d'un autre compte il ne s'ouvre pas non plus :
une écriture partielle en base ne permet plus de substituer une clé à une autre.
Détail et procédure de passage dans [KEY_ROTATION.md](./KEY_ROTATION.md).

### Les deux étages : DEK « gardée » et DEK « ouverte »

`ctx.secure` expose **deux** codecs (`Cipher`), chacun adossé à une clé
différente : c'est le choix du codec qui fait le contrôle d'accès :

| Étage                | Clé                | Emballage                  | Lisible sans mot de passe ? |
| -------------------- | ------------------ | -------------------------- | --------------------------- |
| `ctx.secure` (gardé) | `dek_wrapped`      | `server` **ou** `password` | non quand la feature est ON |
| `ctx.secure.open`    | `open_dek_wrapped` | **toujours** `server`      | oui, toujours               |

La DEK ouverte est une seconde clé aléatoire par utilisateur, créée
paresseusement à la première écriture ouverte et **jamais** ré-emballée par les
handlers `secrecy` : activer le chiffrement par mot de passe ne doit pas
verrouiller cet étage. Elle sert aux données qu'une feature doit pouvoir servir
sans le moindre prompt tout en restant chiffrées au repos, au prix assumé que
le serveur vivant peut les lire (même garantie que la BMK CloudSync).

Par défaut une feature écrit dans l'étage gardé ; `open` est un choix explicite.

## "Chiffrement par mot de passe" (la feature UI)

Nom côté interface du fait de passer `wrap_mode` de `server` à `password`.
Handlers dans `src/features/secrecy/index.ts`. Quand elle est **ON** :

- Le déverrouillage de session (saisie du mot de passe → DEK déballée en mémoire)
  passe par le **`SecureStore`** : `ctx.secure.isUnlocked()` /
  `isUnlockedPassive()`.
- La DEK déverrouillée est cachée par `sessionId` dans une Map en mémoire
  (`sessionDeks`), jamais persistée, effacée à la déconnexion.
- **Fenêtre de grâce glissante** (`reAuthInterval`, en secondes ; défaut
  `DEFAULT_DEK_GRACE_MS` = 60 s). Chaque accès réarme le minuteur. Passé ce délai
  d'inactivité, la DEK est effacée et la prochaine action chiffrée redemande le
  mot de passe. Deux plafonds que rien ne prolonge : un `secrecy.hold` (popup
  ouverte) ne retient la DEK que 2 h d'affilée, et un déverrouillage ne dure
  jamais plus de 24 h, quel que soit le glissement. Un balayeur efface les
  entrées expirées que plus aucune socket ne lit (une DEK pré-cachée au login
  sans WebSocket derrière, par exemple).
- **`reAuthInterval = 0` = validation à chaque action**, au sens « au plus 30 s
  » : la DEK n'est pas mise en cache d'une action à l'autre, mais l'unlock et
  l'action déclenchée sont deux commandes WS distinctes : la DEK déballée est
  donc gardée en **usage unique**
  (`singleUse`, non glissante) le temps de servir cette/ces commande(s), puis
  effacée dès que la rafale se vide. Le dispatcher compte les commandes en vol
  (`enterSessionCommand`/`exitSessionCommand`) : la DEK part quand le dernier
  consommateur termine, ce qui couvre les rafales concurrentes (ex. `notes.list`
    - `notes.folderList`). Un court pont (`SINGLE_USE_BRIDGE_MS` = 30 s) borne un unlock
      jamais consommé. **Côté client**, le store secrecy passe en mode `singleUse` :
      la session n'est jamais tenue pour « déverrouillée », chaque action chiffrée
      redemande le mot de passe.
- Un handler verrouillé renvoie `FeatureError('locked')` → le client affiche le
  prompt de mot de passe habituel, même s'il se croyait encore déverrouillé.
- **Le client suit le serveur.** Chaque mise en cache et chaque effacement de la
  DEK (déverrouillage, verrouillage, expiration trouvée par le balayeur ou une
  lecture, socket fermée, sessions révoquées) est poussé en `secrecy.state` à
  toutes les sockets ouvertes de la session (`onSessionDekChange`, câblé au
  boot sur `LiveHub.toSession`). Les glissements ne sont pas poussés : à
  l'échéance de son compte à rebours, le client relit `secrecy.status` plutôt
  que de se verrouiller d'office, et le store relit aussi l'état à chaque
  (re)connexion, ce qui couvre ce qu'une socket fermée n'a pas entendu. Toute
  fermeture de socket efface la DEK de la session, donc de ses autres onglets.

## Pré-cache de la DEK au login

Pour éviter de saisir le mot de passe deux fois d'affilée (login, puis unlock),
la DEK est déballée **au moment du login** (route `POST /api/auth/login`, où le
mot de passe est disponible en clair) et cachée sous la `sessionId` émise, via
`rememberSessionDek`. Voir `unwrapDekForLogin` dans `src/auth/routes.ts`.

- Ne se déclenche **que** si la feature est ON **et** `reAuthInterval > 0`.
- **Ne se déclenche jamais** au F5 / auto-login : ces flux réutilisent le cookie
  d'accès et n'appellent jamais `/api/auth/login`, donc aucune DEK n'est
  pré-cachée : le serveur redemande alors le mot de passe (comportement voulu).
- **2FA :** la session n'existe qu'après l'étape TOTP. La DEK déballée au login
  est gardée côté serveur dans un _pending store_ (`stashPendingDek`) sous un
  token opaque transporté dans le challenge JWT (champ `pdk`, jamais le mot de
  passe lui-même). L'étape TOTP la réclame (`claimPendingDek`) et la lie à la
  session émise. Nettoyage du matériel crypto en attente :
    - les entrées expirent (≤ fenêtre du challenge 2FA, sweep paresseux) ;
    - un nouveau login purge les pending DEK du même user (`stashPendingDek`
      appelle `discardPendingDeksForUser`), ce qui couvre "Retour puis re-login" ;
    - le bouton "Retour" du prompt 2FA appelle `POST /api/auth/2fa/cancel` qui
      efface le cookie de challenge et `discardPendingDek` (libération immédiate) ;
    - une 2FA désactivée entre les deux étapes libère aussi la DEK.

## La DEK prêtée à une exportation

L'export des données d'un compte ([ACCOUNT_EXPORT.md](./ACCOUNT_EXPORT.md))
écrit l'étage gardé en clair : il lui faut la DEK, sans déverrouiller la
session. `user.exportPrepare` la déballe par le mot de passe qu'il vient de
vérifier (ou par la clé serveur quand le mot de passe ne la protège pas), et
la **prête** sous un jeton opaque (`lendExportDek`, `src/Services/SecureStore.ts`),
sur le modèle de la DEK en attente du 2FA :

- **jamais posée dans la session** : l'export ne déverrouille rien d'autre, et
  le coffre reste fermé dans l'app ;
- retirée **une seule fois**, par le téléchargement, pour ce compte seul
  (`claimExportCipher`) ; le jeton du prêt ne voyage jamais, seul celui du lien
  est dans l'URL ;
- un prêt non retiré meurt à 5 minutes, et un nouveau lien efface le
  précédent ;
- effacée (octets mis à zéro) à la fin de l'export comme à son abandon ;
- `forgetSessionsOf` (changement de mot de passe, suspension, suppression) la
  révoque même en cours d'export : le codec lève `locked` et l'archive s'arrête.

## Notes privées

Application directe des deux étages ci-dessus (`features/notes/src/server/handlers.ts`) :

- la feature Notes **s'ouvre sans mot de passe**. Corps des notes ordinaires et
  noms de dossiers vivent dans l'étage **ouvert** ;
- une note avec le drapeau clair `notes.is_private` a son corps chiffré par la
  DEK **gardée**. Il n'y a aucun contrôle d'accès par-dessus : c'est le
  chiffrement lui-même qui protège, et le serveur ne peut pas la déchiffrer sans
  mot de passe vivant ;
- `notes.list` n'est jamais bloquée : une note privée sortie session verrouillée
  est renvoyée en **summary masqué** (`masked: true`) : métadonnées claires
  seules (id, dossier, rang, dates), jamais de titre ni de corps. Le client
  affiche un cadenas et propose « Déchiffrer », qui n'est que le prompt de
  déverrouillage global suivi d'un re-listage ;
- basculer le drapeau depuis l'éditeur **re-chiffre** la note dans l'autre étage
  à l'enregistrement ;
- `notes.edit` / `notes.archive` / `notes.restore` / `notes.delete` sur une note
  privée exigent en plus une session déverrouillée : ces chemins n'ont pas besoin
  de _lire_ le corps, sans ce garde une session verrouillée pourrait écraser,
  escamoter ou détruire ce qu'elle ne voit pas. `notes.reorder` (positionnement
  pur, n'expose ni ne réécrit le corps) reste libre, même sur une note masquée.

Remplace l'ancien système de verrou par note (mot de passe dédié par note,
`notes.lock_hash`), supprimé : un mot de passe par note n'était pas retenable.

## Authentification

- Mots de passe hachés en **Argon2id** (`src/auth/argon.ts`), upgrade
  transparent des anciens hash bcrypt au login.
- Sessions par JWT (access + refresh en cookies), `sessionId` partagée entre le
  monde HTTP (login) et le monde WS (features). C'est cette `sessionId` qui relie
  le pré-cache de la DEK au login à la session WS qui l'utilisera.
- **Sessions fédérées** : la page d'une autre instance DevEye listée dans
  `FEDERATION_ORIGINS` ouvre une session « au porteur », jetons dans le corps et
  ticket à usage unique pour la socket, sans jamais un cookie. Éteint par défaut.
  Voir [FEDERATION.md](./FEDERATION.md), qui dit aussi ce que ce montage protège
  et ce qu'il ne protège pas.
- 2FA TOTP optionnel avec codes de secours à usage unique. Un code TOTP accepté
  ne se rejoue pas (`last_used_counter`) ; les codes de secours (16 caractères)
  sont condensés sous une clé dérivée de la clé serveur, pas en SHA-256 nu : un
  dump seul ne permet pas de les tester hors ligne.
- **Verrouillage progressif** sur tout ce qui vérifie un secret : login, 2FA,
  déverrouillage du coffre, récupération, activation/désactivation de la 2FA.
  Compteur d'échecs par compte (par identifiant pour le login), 5 échecs → 30 s,
  10 → 5 min, 20 → 1 h ; les commandes WS y passent aussi, puisque la limite de
  débit HTTP ne voit que la poignée de main. Chaque échec est audité.
- **Inscription** (`src/Services/signup`, `src/auth/signupRoutes.ts`) en trois
  étapes : pseudo et adresse, lien reçu par mail, mot de passe.
    - Aucun compte n'existe avant la dernière étape : la demande vit dans
      `pending_signups`, une seule par adresse, et n'y garde que le condensé
      SHA-256 de ses jetons.
    - Le lien vaut 2 h et voyage en fragment d'URL, hors des journaux. Une demande
      expirée est inerte par prédicat, et purgée au démarrage puis toutes les
      10 minutes.
    - L'onglet qui a fait la demande la suit avec un jeton de veille distinct de
      celui du mail : il ne permet que de lire son état.
    - La première étape répond la même chose qu'une adresse ait un compte ou non
      (l'adresse inscrite reçoit un mail qui le lui dit). Seul le pseudo pris est
      révélé. Chaque demande compte aussi contre l'adresse visée (portée `signup`
      du verrouillage progressif), en plus de la limite par IP.
    - Fermée par défaut (page « Accès et maintenance », réglage rangé par
      origine dans `instance_settings`, relu à chaque étape), sauf sur une base
      sans aucun compte : le premier inscrit naît administrateur, le compte
      étant compté sous verrou dans la transaction qui le crée.
    - Sans `SMTP_HOST`, le lien est écrit dans le journal du serveur.
- **Sessions** : changer de mot de passe ou récupérer le coffre révoque toutes
  les autres sessions du compte (jetons de rafraîchissement, DEK en mémoire,
  sockets). Un `sid` révoqué ne peut plus ouvrir de WebSocket, même avec un
  jeton d'accès encore valide.

## L'agent

Un agent n'est pas une sonde avec quelques boutons : c'est un démon
d'administration à distance. Avec la permission correspondante, un opérateur
obtient un shell, un explorateur de fichiers sans bac à sable, les mises à jour
de paquets et l'extinction, sous le compte de l'agent (root pour un service
système). Le modèle de confiance se dit donc sans détour : **qui contrôle le
serveur contrôle les machines**, à ceci près.

- **La politique locale.** La section `[policy]` de l'`agent.toml` dit ce que la
  machine accepte (terminal, écriture de fichiers, extinction, mises à jour,
  élévation, effacement). Aucune trame ne la modifie, l'explorateur n'écrit
  jamais dans le dossier de l'agent, et le rapport de l'appareil la publie pour
  que l'interface grise ce qui serait refusé. C'est le seul réglage de la machine
  que le serveur ne décide pas : une installation « supervision seule » se fait
  là. Limite honnête : un terminal root autorisé rend le reste consultatif.
- **Les ordres signés.** Ce qui exécute du code, écrit ou supprime des fichiers,
  change les privilèges de l'agent ou sa vie (`SIGNED_AGENT_COMMANDS`) porte une
  signature Ed25519 du serveur (`ORDER_SIGNING_KEY`, `src/agent/orders.ts`) sur
  la commande, un nonce, un horodatage et les octets exacts du payload. L'agent
  épingle la clé publique à l'enrôlement, refuse un ordre non signé, rejoué, ou
  daté à plus de cinq minutes de son horloge, et refuse tout sans clé épinglée.
  Ce que ça protège : tenir la socket ne suffit plus (un proxy qui termine le
  TLS, un jeton d'appareil volé et présenté à un faux serveur). Ce que ça ne
  protège pas : un serveur compromis avec sa clé, d'où la politique locale.
- **Le transport.** TLS (rustls) sans aucun moyen de désactiver la vérification.
  Le `http://` en clair est refusé hors de la machine elle-même, sauf choix
  explicite à l'enrôlement (`--insecure-plaintext`), que l'interface signale. Le
  jeton voyage dans l'en-tête `Authorization`, jamais dans l'URL ; il expire à 30
  jours et le serveur le remplace à la connexion avant (`token_hash_prev` garde
  l'ancien valable tant que le nouveau n'a pas servi). Tout refus ferme la socket
  du même `1008` : une sonde n'apprend rien. Seul un agent qui présente un jeton
  valide pour un appareil en attente d'approbation reçoit `4001`, qui lui dit de
  réessayer : il connaissait déjà son statut par la réponse d'enrôlement.
- **L'appairage.** Un code de liaison vaut sept jours au plus, sert le nombre
  de machines choisi à l'émission et vise un espace ; tout membre qui y gère
  les appareils le voit et peut l'invalider. Un code long ou à plusieurs usages
  compte 12 caractères ; les échecs verrouillent l'adresse, et un code dont
  l'émetteur ne gère plus les appareils de l'espace ne vaut plus rien. Une
  machine neuve est active dès la liaison, si l'offre du propriétaire le permet
  (vérifié avant de dépenser un usage). Une empreinte déjà connue de l'espace
  reprend la fiche existante, avec un code à usage unique seulement : son
  ancien jeton tombe, sa session aussi, et l'appareil attend qu'on l'approuve,
  refusé à la socket jusque-là, puisque l'empreinte est déclarée par
  l'appelant. Un code à plusieurs usages la refuse, pour que deux clones ne se
  prennent pas leur fiche. Révoquer archive l'appareil et détruit son jeton :
  seul un nouvel appairage le fait revenir.
- **Les droits décidés sur la machine.** `[policy]` (dix interrupteurs :
  terminal, lecture et écriture de fichiers, alimentation, mises à jour,
  élévation, auto-destruction, Docker, déploiements, CloudSync) se fixe à la
  liaison (`--deny`, `--monitor-only`) et ne change que sur la machine
  (`deveye-agent policy`) ; aucun ordre du serveur n'y touche, et la rotation
  du jeton réécrit le fichier tel qu'il est sur disque. La surveillance
  (mesures, rapports, inventaire Docker) n'est jamais refusée.
- **Le script d'installation** (`/install.sh`, `/install.ps1`) exécute ce que
  le serveur envoie : un serveur compromis servirait un script sans les `--deny`
  demandés. Pour une machine où cela compte, le binaire publié et un `link`
  tapé à la main s'en passent. Il ne porte aucun secret ; l'origine y est
  validée avant d'être posée entre apostrophes.
- **L'auto-mise à jour** ne dépend pas du serveur : sha256 du binaire et
  signature Ed25519 de la CI, clé publique gravée à la compilation, échec fermé
  sans clé, et seule la cible de ce binaire se télécharge. Un serveur compromis
  ne pousse pas de binaire, ni une version plus ancienne que celle en marche,
  qui ignorerait les interrupteurs ajoutés depuis.
- **Ce qui remonte.** Tout seul : métriques, programmes (nom, chemin, compte,
  jamais la ligne de commande ni l'environnement), ports et connexions, posture,
  matériel, et pour Sentinelle des empreintes et des issues d'authentification
  (voir son README, dont ce qu'un compte local peut ou non lui faire croire). À
  la demande : journaux (les quatre fichiers proposés, pas un chemin libre),
  fichiers, terminal. La sortie d'un terminal n'est relayée qu'à la connexion qui
  l'a ouvert, et n'est jamais persistée.
- **CloudSync** : la racine d'un partage est choisie côté serveur, sous un droit
  qui n'est pas celui du terminal. L'agent refuse un dossier système, la racine,
  son propre dossier, un chemin qu'un lien symbolique ferait sortir du partage,
  et, si `sync_roots` est renseigné sur la machine, tout ce qui n'y figure pas.
- **Le service système** ne porte que `RestrictRealtime` et `LockPersonality` :
  tout ce que systemd confinerait de plus s'appliquerait au shell de l'opérateur
  et aux mises à jour de paquets, qui sont les enfants de l'agent.

## CloudSync, pas encore zero-knowledge

Les contenus synchronisés (feature CloudSync) ne passent **pas** par le
chiffrement par enveloppe utilisateur : la synchro tourne en tâche de fond,
que la session soit verrouillée ou non, et des fichiers de plusieurs Go ne
peuvent pas vivre en base. À la place :

- les contenus vivent dans un **blob store** par partage, sur le disque du
  serveur ou dans le bucket S3 de l'hôte (`<storage_key>/blobs/…`), adressés
  par le SHA-256 de leur clair ; le bucket ne reçoit que des blobs déjà
  chiffrés, jamais la clé ;
- chaque blob est chiffré **AES-256-GCM en flux** par une **BMK** (Blob Master
  Key, 32 octets) générée au premier boot, wrappée par la clé serveur
  (`deps.keys.sealBytes`, soit `crypt.seal`, même schéma que le
  wrap des DEK) et rangée dans `sync_meta` : la rotation de `CRYPT_KEY_A/B` ne
  demande que de re-wrapper 32 octets, jamais de re-chiffrer les blobs ;
- l'index (chemins relatifs, hashes, tailles, mtimes, appareil source) est en
  clair dans MySQL, nécessaire au merge, à la navigation et à la volumétrie.

Le format de blob porte un octet de version : `0x01` (flux GCM unique) reste lu
pour toujours, `0x02` scelle par blocs de 1 Mio (nonce dérivé d'un compteur,
AAD = compteur + marqueur de fin contre la troncature) : c'est ce qui rend un
transfert interrompu reprenable sans jamais retransmettre les octets déjà reçus.

État actuel : le serveur détient la BMK, donc lit les blobs. Cible : une clé
que le serveur ne détient pas, mécanisme à définir (elle ne peut pas être la
DEK personnelle, voir ci-dessous). Tant que ce n'est pas fait, CloudSync est
l'exception documentée au zero-knowledge de l'étage gardé.

**Pourquoi pas la DEK personnelle** : la DEK gardée
est liée à une session WebSocket vivante (fenêtre glissante de 60 s, effacée à
la fermeture de la socket, jamais persistée) et le code la déclare
structurellement inatteignable sans session. Or une session CloudSync est
pilotée par l'agent, sans aucune session utilisateur. Un partage ainsi chiffré
ne se synchroniserait que pendant qu'un onglet est ouvert et déverrouillé, et un
transfert de plusieurs Go survivrait de toute façon à la fenêtre. C'est
contradictoire avec la promesse du produit, pas seulement coûteux.

Ce que ça protège : le disque au repos (vol, snapshot hors-ligne). Ce que ça
ne protège pas : une compromission du serveur vivant (qui détient la clé).
C'est le même niveau de garantie que les secrets liés à l'auth (2FA), et un
cran en dessous des données « mot de passe »/notes, documenté ici pour que le
choix reste explicite. Détails d'implémentation du format de conteneur :
`devb.ts` de `@deveye/types` (`sdk/server`).

## Hébergement, lisible par le serveur par construction

Le module Hébergement sert des fichiers à des visiteurs sans compte : le serveur
doit donc pouvoir les lire, et ils ne passent pas par l'étage gardé.

- Les octets vivent dans le magasin d'objets de l'hôte (disque, ou bucket
  `STORAGE_S3_*`), scellés au conteneur `DEVB` v2 par une clé **dérivée** de la
  clé serveur (`keys.derive('deveye-hosting', 'files-v1')`), jamais stockée. Le
  bucket ne reçoit que du chiffré, et un envoi est scellé dans le dossier local
  des envois avant d'y partir. La clé ne dépend d'aucun espace : partager ou
  déplacer un dossier ne relit pas un octet de fichier. Perdre `CRYPT_KEY_A/B`
  rend tous les fichiers hébergés illisibles.
- Les noms des dossiers, sous-dossiers, fichiers et adresses sont chiffrés à l'étage
  ouvert de l'espace. L'unicité d'un nom dans son dossier tient à un condensat
  à clé (HMAC, clé dérivée), jamais au nom en clair.
- Le mot de passe d'une adresse est haché (scrypt, sel propre). L'accès qu'il
  ouvre est un cookie `HttpOnly`, `SameSite=Lax`, signé par une clé dérivée, qui
  porte son échéance (une journée) et la version du mot de passe : le changer ou
  le retirer ferme tous les accès ouverts.
- Les pages publiques n'ont aucun script (`default-src 'none'`, formulaires sur
  la même origine, `frame-ancestors 'none'`). Un fichier ne s'affiche dans le
  navigateur que pour les types qui ne peuvent pas exécuter de code (images,
  son, vidéo, texte brut), toujours avec `nosniff` et `CSP: sandbox` ; tout le
  reste part en pièce jointe. Le téléchargement du propriétaire passe par un
  ticket, sur l'origine de l'app, toujours en pièce jointe.
- Les signalements sont scellés par la clé serveur (`keys.sealBytes`, liés à
  leur référence) : ils se lisent sans aucun espace, survivent au dossier, et ne
  sont jamais montrés à qui a publié le contenu signalé.

## Uptime : l'étage ouvert appliqué à une tâche de fond

La feature Uptime (module `features/uptime/`, `src/server/service.ts` et
`src/server/handlers.ts`)
sonde des services HTTP **en continu, sans session ni mot de passe** : c'est le
serveur seul qui travaille, souvent alors que personne n'est connecté. Elle
utilise donc systématiquement l'**étage ouvert** :

- chiffrés (`ctx.cipher()` côté handlers, `deps.cipherFor()` côté ordonnanceur,
  qui n'expose _que_ cet étage, l'étage gardé n'ayant aucun sens sans session) : le nom
  du service, son URL, le mot-clé attendu, les messages d'erreur (ligne du
  service, ligne de chaque ping, ligne d'incident) et les canaux de notification
  (libellé, adresse mail, URL de webhook) dans `notification_channels`
  (voir [NOTIFICATIONS.md](./NOTIFICATIONS.md)) ;
- en clair : ce qui pilote la planification (`interval_seconds`,
  `timeout_seconds`, `enabled`, `last_checked_at`) et ce qu'agrègent les
  graphiques (`status`, `response_ms`, `http_status`, horodatages, agrégat
  journalier). Aucune de ces colonnes ne dit _quoi_ est surveillé.

Même garantie que la BMK CloudSync : protégé au repos, lisible par un serveur
vivant compromis. Le choix est ici structurel : un moniteur qui exigerait le mot
de passe ne pourrait tout simplement pas sonder.

Le client bâti publie aussi `/.well-known/deveye-build.json`, l'empreinte
SHA-256 de chacun de ses fichiers. Ce n'est pas une preuve (le serveur qui le
sert pourrait le réécrire) mais la liste de ce qu'un contrôle d'intégrité tenu
par une **autre** instance doit relire ; la référence, elle, est apprise et
gardée là-bas. Voir le README d'Uptime.

## Projets : l'étage choisi par l'utilisateur

Contrairement à Uptime (toujours ouvert) et au coffre (toujours gardé), les
projets laissent le choix **par projet** : `projects.security_tier` vaut `open`
ou `guarded`, exactement comme `mail_accounts.security_tier`.

Les étages vivent dans le module (`features/projects/src/server/_shared.ts`) :
`cipherFor(ctx, tier)` rend `ctx.cipher()` (l'étage ouvert) ou
`ctx.cipher('private')` (l'étage gardé, qui n'existe que dans une session
déverrouillée), `assertProjectUnlocked` interroge `ctx.secrecy.isUnlocked()`
avant une écriture qui n'a pas besoin de lire, et le service du module ne
connaît que `deps.cipherFor(ws)`, l'étage ouvert : ce qu'il offre aux autres
modules (`PROJECTS_USAGE_PROVIDER`) ne touche jamais un projet gardé.

Ce qui en découle :

- **Tout l'arbre d'un projet suit l'étage de son projet** : cartes, messages,
  jalons, événements d'historique (la liste, à tenir à jour, est
  `features/projects/src/server/repo/rekey.ts`). Pas de tier par ligne : c'est
  ce qui rend la bascule atomique (`reencryptProjectTree`), qui lit et
  re-chiffre tout **avant** la moindre écriture et abandonne sans rien toucher
  si une seule ligne résiste. Le cache git et les cibles de déploiement n'en
  font pas partie : objets d'espace, ils vivent à l'étage ouvert quel que
  soit le tier des projets qui les relient.
- **`guarded` n'existe qu'en espace personnel.** En espace partagé, les deux
  étages utilisent la clé de l'espace : le projet serait lisible par tous tout
  en s'annonçant confidentiel. Refus explicite plutôt que ce mensonge. Un
  espace partagé reste chiffré, sous la clé de l'espace, à l'étage ouvert.
- **Un projet gardé perd ses intégrations.** La synchronisation git et le suivi
  de déploiement tournent sans session : ils n'atteindront jamais l'étage gardé.
  La règle est portée par la liaison elle-même : `projects.repoLink` et ses
  trois sœurs refusent un projet gardé, et passer un projet en gardé retire ses
  liaisons. Les services des modules Git et Déploiement n'ont donc jamais un
  projet gardé à lire, et les lectures d'usage que Projets leur offre filtrent
  de toute façon sur l'étage ouvert.
- **Seul un projet ouvert se publie.** La page publique d'un projet
  (`features/projects/src/server/publicPage/`) déchiffre son tableau sans
  session, à l'étage ouvert, pour qui a le lien. Un projet gardé ne se publie
  pas, et le passer en gardé retire sa publication, lien compris : un lien
  donné comme public ne doit jamais rouvrir un projet devenu confidentiel. La
  route revérifie l'étage à chaque calcul. Ce qu'elle garde en mémoire (le
  HTML, trente secondes) est ce que le visiteur lit de toute façon.

### Ce qui reste en clair, et pourquoi

Le module en garde plus que les autres, à dessein : ce sont les colonnes sans
lesquelles il faudrait déchiffrer des dizaines de milliers de lignes pour
afficher un écran.

- **`assignee_user_id`** : « toutes mes tâches, tous projets » en une requête.
  Le serveur connaît déjà l'appartenance à l'espace : il n'apprend rien de neuf.
- **`message_count` et le point d'eau haute de lecture** : le badge « des
  messages non lus ici » sans ouvrir un seul message.
- **`committed_at` et `author_ref`** : le graphe des commits est une agrégation
  SQL. `author_ref` est un condensé de l'adresse e-mail (16 caractères de son
  sha256) : identité stable et graine de couleur, **sans adresse en clair**.
- **Les dates, `archived_at`, `counts_as_done`** : la frise, les retards et
  l'avancement, tous calculés sans clé.

Aucune de ces colonnes ne dit _quoi_ est fait, par qui hors de l'espace, ni ce
qui est écrit. Les titres, descriptions, messages, noms de branches et messages
de commit passent tous par le chiffre.

> **Corollaire à ne pas oublier** : le chiffrement est non déterministe, donc ce
> qui doit être **unique** ne peut pas être chiffré. D'où les colonnes `*_ref`
> (`author_ref`, `name_ref`, `tag_ref`), des condensés stables qui portent
> l'unicité pendant que la valeur lisible vit dans le payload chiffré.

Les secrets d'accès (`ft_git_credentials.secret_enc` pour un jeton GitHub,
`ft_deploy_credentials.secret_enc` pour une clé Dokploy : chaque module possède
les siens depuis les migrations 099 et 100, qui ont vidé puis supprimé la table
commune `workspace_credentials`) sont **toujours** sous l'étage ouvert, quel que
soit le tier des projets qui s'en servent : le service de fond doit les lire
sans session. Ils ne sont jamais renvoyés au client, qui n'en reçoit qu'un
booléen `hasSecret`.
