# Modèle de sécurité de DevEye

Référence des mécanismes de chiffrement et d'authentification de l'app : ce que
chaque étage garantit, et ce qu'il ne garantit pas.

## Ce que le serveur peut lire, en une phrase

Les contenus sont chiffrés au repos, sous une clé par utilisateur. Par défaut,
le serveur détient de quoi déballer cette clé : il lit. Quand l'utilisateur
active le **chiffrement par mot de passe**, l'étage gardé de son espace
personnel ne s'ouvre plus qu'avec son mot de passe : la base de données et la
clé du serveur ne suffisent plus, et un serveur dont la session est verrouillée
ne lit pas. Un serveur en marche reçoit pourtant ce mot de passe à chaque
connexion et à chaque déverrouillage, en tire la clé et la garde en mémoire
tant que la session est déverrouillée : pendant ce temps-là, il lit. L'étage
ouvert (ce qu'une tâche de fond doit servir sans personne devant l'écran :
relevés, identifiants d'infrastructure, CloudSync) reste lisible par un serveur
vivant, quoi qu'il arrive, comme tout ce que contient un espace partagé. Seule
exception : un partage CloudSync **chiffré de bout en bout**, dont seuls les
appareils ont la clé (voir la section CloudSync).

Le chiffrement par mot de passe n'est donc pas du « zero knowledge » : le mot
promet un serveur qui ne reçoit jamais de quoi lire, et celui-ci reçoit le mot
de passe. Ce qu'il garantit se dit autrement : illisible dans la base de
données, et tant que la session est verrouillée. Un partage CloudSync créé de
bout en bout, lui, tient la promesse pour ses contenus : sa clé ne quitte pas
les appareils et ne dérive pas du mot de passe du compte. Le détail de ce que
le serveur lit toujours est dans
[Ce que le serveur peut toujours lire](#ce-que-le-serveur-peut-toujours-lire),
celui de ce qui n'est pas chiffré dans [Ce qui reste en clair](#ce-qui-reste-en-clair).

## Chiffrement par enveloppe ("envelope encryption")

Système central de chiffrement des données de features (notes, mots de passe…).
Implémenté par `src/Services/SecretKeyService.ts` + `src/Services/SecureStore.ts`,
décrit côté types dans `src/domain/secrecy.ts` de `@deveye/types`.

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
      suivant, sans migration). Le serveur ne peut alors plus déballer la DEK
      sans le mot de passe, qu'il reçoit à la connexion et au déverrouillage.
      Limite à connaître : activer le chiffrement ne fait pas
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
  sécurité), stocké dans `recovery_wrapped`. La page Sécurité le crée ou le
  refait sur le mot de passe (`secrecy.regenerateRecovery`) : l'ancien cesse
  aussitôt de servir.

**Conséquence :** ce qu'une feature chiffre n'est jamais stocké en clair en
BDD. Même feature OFF, ces contenus sont chiffrés (DEK distincte par user) ;
seul le niveau d'emballage de la DEK change. Tout n'est pas chiffré pour
autant : les nombres, les dates, les états, et ce que le serveur traite sans
session (mesures des machines, chemins des fichiers synchronisés, comptes et
espaces) ne le sont pas. Voir [Ce qui reste en clair](#ce-qui-reste-en-clair).

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

Chaque contexte expose **deux** codecs (`Cipher`), chacun adossé à une clé
différente : c'est le choix du codec qui fait le contrôle d'accès :

| Étage  | Côté module (SDK)       | Contexte natif    | Clé                | Emballage                  | Lisible sans mot de passe ?                           |
| ------ | ----------------------- | ----------------- | ------------------ | -------------------------- | ----------------------------------------------------- |
| gardé  | `ctx.cipher('private')` | `ctx.secure`      | `dek_wrapped`      | `server` **ou** `password` | non quand la feature est ON, dans un espace personnel |
| ouvert | `ctx.cipher()` (défaut) | `ctx.secure.open` | `open_dek_wrapped` | **toujours** `server`      | oui, toujours                                         |

Dans un **espace partagé**, les deux étages utilisent la clé de l'espace (WDK),
toujours emballée par la clé serveur : l'étage gardé y est lisible par le
serveur et par tout membre, feature ON ou non (`SecureStore.resolveDek`). C'est
pourquoi une note privée, un projet confidentiel et une boîte mail protégée y
sont refusés. Le coffre, lui, y existe : c'est le coffre de l'espace, lisible
par le serveur, et son écran le dit.

Un module écrit par le SDK : `ctx.cipher()` et `ctx.cipher('private')` pour les
codecs, `ctx.secrecy.isUnlocked()` pour l'état de verrou. `ctx.secure` est le
contexte natif du cœur, que `src/features/_sdk/context.ts` projette sur le SDK.

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
  `isUnlockedPassive()` en natif, `ctx.secrecy.isUnlocked()` dans un module.
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
- **`reAuthInterval = 0` = validation à chaque action**, au sens « au plus
  30 s » : la DEK n'est pas mise en cache d'une action à l'autre, mais l'unlock
  et l'action déclenchée sont deux commandes WS distinctes : la DEK déballée est
  donc gardée en **usage unique** (`singleUse`, non glissante) le temps de
  servir cette ou ces commandes, puis effacée dès que la rafale se vide. Le
  dispatcher compte les commandes en vol
  (`enterSessionCommand`/`exitSessionCommand`) : la DEK part quand le dernier
  consommateur termine, ce qui couvre les rafales concurrentes (deux commandes
  lancées ensemble à l'ouverture d'une feature, par exemple). Un court pont
  (`SINGLE_USE_BRIDGE_MS` = 30 s) borne un unlock jamais consommé. **Côté
  client**, le store secrecy passe en mode `singleUse` : la session n'est jamais
  tenue pour « déverrouillée », chaque action chiffrée redemande le mot de
  passe.
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
`rememberSessionDek`. Voir `unwrapDekForLogin` dans `src/auth/loginRoutes.ts`.

- Ne se déclenche **que** si la feature est ON **et** `reAuthInterval > 0`.
- **Ne se déclenche jamais** au F5 / auto-login : ces flux réutilisent le cookie
  d'accès et n'appellent jamais `/api/auth/login`, donc aucune DEK n'est
  pré-cachée : le serveur redemande alors le mot de passe (comportement voulu).
- **Étapes après le mot de passe** (code par mail, application, SMS) : la
  session n'existe qu'après la dernière. La DEK déballée au login est gardée
  côté serveur dans un _pending store_ (`stashPendingDek`) sous un token opaque
  que la connexion en cours garde en mémoire (`src/auth/loginChallenge.ts`),
  jamais le mot de passe lui-même. La dernière étape la réclame
  (`claimPendingDek`) et la lie à la session émise. Nettoyage du matériel crypto
  en attente :
    - les entrées expirent avec la connexion en cours
      (`LOGIN_CHALLENGE_TTL_SECONDS`, 15 min par défaut, sweep paresseux) ;
    - un nouveau login purge les pending DEK du même user (`stashPendingDek`
      appelle `discardPendingDeksForUser`), ce qui couvre "Retour puis re-login" ;
    - le bouton "Retour" appelle `POST /api/auth/login/cancel`, qui efface le
      cookie de la connexion en cours et `discardPendingDek` (libération
      immédiate), comme cinq codes faux ou trop de codes redemandés.

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

## Ce que le registre des opérations garde en mémoire

Une opération longue que le serveur suit ([TASKS.md](./TASKS.md)) laisse dans
sa mémoire, jamais en base, deux choses : ses libellés (titre, ce sur quoi elle
porte, étape, phrases de fin), 24 h au plus, et la réponse de sa commande, dix
minutes au plus, pour la page qu'une coupure en a séparée.

- **Jamais à quelqu'un d'autre.** Les libellés ne partent que vers les sockets
  du compte qui a lancé l'opération. La réponse ne se rend qu'à la session qui
  l'a lancée, sur présentation du `requestId` de la requête, qui n'est jamais
  diffusé. Une session révoquée perd les réponses qu'elle attendait.
- **Rien quand le mot de passe garde l'espace.** Dans un espace personnel dont
  l'étage gardé attend le mot de passe (`SecureStore.isPasswordGated`), un
  libellé ou une réponse peut citer ce que cet étage protège : le registre ne
  les montre à aucun autre onglet et ne les retient pas au-delà de la commande.
  Il ne sait, tant qu'elle tourne, que la socket à qui répondre. Rien de
  déchiffré ne survit donc à la DEK de la session.
- **L'entrée d'une commande n'est jamais retenue**, et l'échec montré aux
  autres onglets ne porte que le code et la phrase du refus, pas ses `details`.
- **L'opération d'un service vient de l'étage ouvert.** Un service travaille
  sans session : ce qu'il dit de son opération, le serveur le lisait déjà. Elle
  paraît donc dans tout espace, gardé ou non, mais seulement pour un compte
  dont le droit sur la fonctionnalité et l'élément vient d'être relu.

## Notes privées

Application directe des deux étages ci-dessus (`features/notes/src/server/handlers.ts`) :

- la feature Notes **s'ouvre sans mot de passe**. Corps des notes ordinaires et
  noms de dossiers vivent dans l'étage **ouvert** ;
- une note avec le drapeau clair `notes.is_private` a son corps chiffré par la
  DEK **gardée**. Il n'y a aucun contrôle d'accès par-dessus : c'est le
  chiffrement lui-même qui protège. Avec le chiffrement par mot de passe, le
  serveur ne la déchiffre que session déverrouillée. Sans lui, la DEK gardée
  est emballée par la clé serveur : la note s'ouvre sans saisie et le serveur la
  lit, si bien que l'éditeur ne propose le drapeau qu'aux comptes qui ont
  activé le chiffrement par mot de passe ;
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

## Authentification

- Mots de passe hachés en **Argon2id** (`src/auth/argon.ts`) ; un hachage bcrypt
  encore en base est remplacé par Argon2id à la connexion suivante.
- Sessions par JWT (access + refresh en cookies), `sessionId` partagée entre le
  monde HTTP (login) et le monde WS (features). C'est cette `sessionId` qui relie
  le pré-cache de la DEK au login à la session WS qui l'utilisera.
- **Sessions fédérées** : la page d'une autre instance DevEye listée dans
  `FEDERATION_ORIGINS` ouvre une session « au porteur », jetons dans le corps et
  ticket à usage unique pour la socket, sans jamais un cookie. Éteint par défaut.
  Voir [FEDERATION.md](./FEDERATION.md), qui dit aussi ce que ce montage protège
  et ce qu'il ne protège pas.
- **Les étapes d'une connexion** (`src/auth/loginRoutes.ts`), dans l'ordre :
  le mot de passe, un code par mail si le navigateur est inconnu, le code de
  l'application si la 2FA est active, un code par SMS si le compte l'a
  demandé et que le navigateur est inconnu. Le mail part dès le mot de passe
  validé : même si la 2FA arrête l'intrus, le titulaire apprend que son mot de
  passe est connu. Le SMS, payant, part en dernier : seul qui a franchi le
  reste peut en déclencher un. Un code envoyé vaut 10 minutes, n'existe côté
  serveur que condensé sous une clé dérivée de la clé serveur, se redemande au
  plus toutes les 60 s et cinq fois ; cinq codes faux annulent la connexion. La
  connexion en cours vit en mémoire, nommée par un jeton signé (cookie `dv_lc`,
  ou le corps pour une origine fédérée) qui ne porte aucun secret.
    - **Code par mail** : actif par défaut pour tout compte, il n'existe que si
      le serveur envoie du mail (`SMTP_HOST`). Le couper demande le mot de
      passe. Un serveur de mail en panne ne ferme pas la porte à tous : l'étape
      est sautée, journalisée en erreur et auditée. C'est un choix assumé
      (l'administrateur aussi se connecte par là), et la limite de cette
      protection.
    - **Code par SMS** : n'existe que si le serveur envoie des SMS
      (`SMS_OVH_*`, l'API d'OVHcloud, `src/Services/sms`). Le numéro se
      vérifie par un code reçu avant de servir ; l'ajouter, le changer, le
      retirer ou couper le code demandent le mot de passe, pour qu'une session
      volée ne déplace pas le code vers son propre téléphone. Il est scellé par
      la clé serveur (`user_phones.phone_sealed`, étiquette `phone`) : la
      connexion le lit avant toute session. Un SMS coûte : dix par compte et
      vingt par adresse IP sur 24 h, au-delà la connexion s'arrête (seul qui a
      franchi les autres étapes en est là) ; un service d'envoi en panne fait
      sauter l'étape, comme pour le mail.
    - **Navigateurs de confiance** : cochée à une étape de code envoyé, la
      confiance pose un jeton aléatoire dans le cookie `dv_tb` (`HttpOnly`,
      `SameSite=Strict`, chemin `/api/auth`, jusqu'à quatre comptes par
      navigateur) ; la base n'en garde que le condensé, le libellé tiré du
      User-Agent et ses dates (`trusted_browsers`). Ce navigateur saute alors
      les codes envoyés, jamais la 2FA, pendant 90 jours après sa dernière
      connexion. Sécurité les liste et les retire ; changer de mot de passe ou
      récupérer le coffre les retire tous.
    - **Historique des connexions** : chaque connexion réussie laisse une ligne
      (`login_history`) avec le navigateur, l'adresse IP, les codes franchis,
      si le navigateur était de confiance et la session ouverte. Sécurité
      montre les 30 derniers jours, en lecture seule : le compte ne l'efface
      pas, un intrus n'y efface donc pas sa trace, et la purge quotidienne
      garde 90 jours. À côté, « Déconnecter les autres appareils » révoque
      toutes les sessions sauf la sienne, comme le fait un changement de mot de
      passe.
- 2FA TOTP optionnel avec codes de secours à usage unique. Un code TOTP accepté
  ne se rejoue pas (`last_used_counter`) ; les codes de secours (16 caractères)
  sont condensés sous une clé dérivée de la clé serveur, pas en SHA-256 nu : un
  dump seul ne permet pas de les tester hors ligne. La mettre en place exige le
  mot de passe du compte, en régénérer les codes de secours exige un code : la
  2FA ouvre les machines (voir [L'agent](#lagent)), une session seule ne doit
  pas se la donner.
- **Verrouillage progressif** sur tout ce qui vérifie un secret : login, 2FA,
  code envoyé par mail ou SMS, déverrouillage du coffre, récupération,
  activation/désactivation de la 2FA.
  Compteur d'échecs par compte (par identifiant pour le login), 5 échecs → 30 s,
  10 → 5 min, 20 → 1 h ; les commandes WS y passent aussi, puisque la limite de
  débit HTTP ne voit que la poignée de main. Chaque échec est audité. La
  connexion accepte le pseudo ou l'adresse du compte, chacun avec son compteur :
  un compteur commun verrouillerait l'adresse après des échecs sur le pseudo, et
  dirait ainsi à un inconnu à quel compte elle appartient.
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
- **Mot de passe oublié** (`src/Services/passwordReset`,
  `src/auth/passwordResetRoutes.ts`) : l'adresse du compte, un lien reçu par
  mail, le nouveau mot de passe.
    - La demande vit dans `password_resets`, une seule par compte, condensé
      SHA-256 du jeton seulement. Le lien vaut 1 h, voyage en fragment d'URL et
      ne sert qu'une fois : la ligne est supprimée dans la transaction qui pose
      le mot de passe. Changer de mot de passe ou récupérer le coffre efface une
      demande en cours.
    - La première étape répond la même chose qu'une adresse ait un compte ou
      non, et le mail part sans être attendu : la durée de la réponse ne trahit
      pas non plus l'existence du compte. Chaque demande compte contre
      l'adresse visée (portée `reset`), en plus de la limite par IP.
    - Un compte en chiffrement par mot de passe ne se réinitialise qu'avec son
      code de récupération : la DEK est déballée par le code, ré-emballée par le
      nouveau mot de passe, et un nouveau code remplace l'ancien, comme
      `secrecy.recover`. Les essais comptent dans la portée `recover`, et un
      mauvais code laisse le lien vivant. Sans code de récupération, aucun lien
      n'est créé : le mail explique que seul le mot de passe actuel ouvre le
      compte. Le serveur ne peut pas déballer cette DEK, et une réinitialisation
      qui la perdrait n'existe pas.
    - Aucune session ne s'ouvre à la fin : la connexion suivante repasse par
      les étapes du compte (2FA, code par mail ou SMS). Un lien reçu par mail ne
      contourne pas un second facteur.
- **Sessions** : changer de mot de passe ou récupérer le coffre révoque toutes
  les autres sessions du compte (jetons de rafraîchissement, DEK en mémoire,
  sockets). Le réinitialiser les révoque toutes, avec les navigateurs de
  confiance. Un `sid` révoqué ne peut plus ouvrir de WebSocket, même avec un
  jeton d'accès encore valide.

## L'agent

Un agent relié sans rien permettre est une sonde : il mesure, rapporte, et ne
prend aucun ordre. Dès que la machine le permet, c'est un démon
d'administration à distance : avec la permission correspondante, un opérateur
obtient un shell, un explorateur de fichiers sans bac à sable, les mises à jour
de paquets et l'extinction, sous le compte de l'agent (root pour un service
système). Le modèle de confiance se dit donc sans détour : **qui contrôle le
serveur contrôle ce que chaque machine lui a permis**, à ceci près.

- **La confirmation pour piloter.** Le serveur signe pour toute session qui a
  les droits : un mot de passe ou un cookie volés suffiraient donc à piloter
  les machines. Faire agir une machine ou en lire le contenu (terminal,
  fichiers, journaux, conteneurs, paquets, alimentation, privilèges, tunnels,
  CloudSync, un appairage) exige en plus la double authentification et un code
  de l'application saisi dans CETTE session depuis moins que le délai choisi
  par le compte (15 min par défaut, de 1 à 480), glissant à chaque action, au
  plus 12 h d'affilée (`src/features/stepup`, `assertStepUp`). La règle est par
  personne : un membre sans double authentification voit les machines, il ne
  les pilote pas. Regarder (mesures, état, processus, inventaire Docker) ne
  demande rien, et une tâche de fond (sauvegarde, déploiement) non plus : la
  confirmation a eu lieu quand on l'a réglée. Une session volée ne peut ni poser
  sa propre application (le mot de passe est exigé pour mettre la 2FA en
  place) ni se fabriquer des codes de secours (un code est exigé pour les
  régénérer). Ce que ça ne protège pas : un serveur compromis.
- **La politique locale.** La section `[policy]` de l'`agent.toml` dit ce que la
  machine accepte (douze interrupteurs, listés plus bas), et rien n'y est
  permis par défaut : une machine reliée sans le dire n'est que surveillée.
  Aucune trame ne la modifie, l'explorateur n'atteint jamais le dossier de
  l'agent (ni en écriture, ni en lecture, ni par un de ses parents : une
  recherche ou une analyse lancée plus haut n'y entre pas), et le rapport de
  l'appareil la publie pour que l'interface grise ce qui serait refusé. C'est
  le seul réglage de la machine que le serveur ne décide pas. Limite honnête :
  le terminal root est un interrupteur à part parce qu'une fois permis il rend
  les autres consultatifs, et sur un agent root l'écriture de fichiers ou
  Docker y mènent aussi.
- **Les ordres signés.** Ce qui exécute du code, écrit, déplace, supprime ou
  lit le contenu d'un fichier, change les privilèges de l'agent, sa vie ou son
  jeton, ou commande ce que CloudSync écrit (`SIGNED_AGENT_COMMANDS`) porte une
  signature Ed25519 du serveur (`ORDER_SIGNING_KEY`, `src/agent/orders.ts`) sur
  la commande, l'identifiant de l'appareil, un nonce, un horodatage et les
  octets exacts du payload. Une seule clé signe pour toutes les machines d'un
  serveur : sans l'identifiant, un ordre signé pour l'une vaudrait sur toutes.
  L'agent épingle la clé publique à l'enrôlement, refuse un ordre non signé,
  signé pour une autre machine, rejoué, ou daté à plus de cinq minutes de son
  horloge, et refuse tout sans clé épinglée. Un jeton tourné qui nomme une autre
  machine est refusé aussi : l'agent ne se réenrôle pas sous un autre appareil.
  Les morceaux d'un téléchargement CloudSync ne sont pas signés (un par
  mégaoctet épuiserait la fenêtre des nonces) mais n'atterrissent que dans un
  transfert qu'un `sync.applyStart` signé a annoncé, pour ce partage et ce
  contenu ; la mise à jour de l'agent ne l'est pas non plus, pour qu'un agent
  d'avant ce format puisse encore la recevoir.
  Une trame n'est lue qu'une fois, à cette porte : ce qu'elle admet est ce qui
  s'exécute, et une trame qu'elle ne sait pas lire (une signature mal formée,
  un champ inconnu) est ignorée, jamais exécutée. Ce que ça protège : tenir la
  socket ne suffit plus (un proxy qui termine le TLS, un jeton d'appareil volé
  et présenté à un faux serveur). Ce que ça ne protège pas : un serveur
  compromis avec sa clé, d'où la politique locale.
- **L'enrôlement d'un service système.** La config dit à l'agent quel serveur
  croire et quelle clé épingler : un agent root qui la lirait dans un dossier
  qu'un compte ordinaire peut écrire donnerait root à ce compte. Un service
  système range donc son enrôlement dans un dossier à root seul
  (`/var/lib/deveye`, `ProgramData\deveye` sous Windows), et un agent
  privilégié refuse de tourner sur un fichier qu'un autre compte, ou l'un de ses
  dossiers parents, pourrait réécrire. Les compromissions se bornent ainsi à
  leur compte : prendre l'utilisateur d'une machine ne donne pas son agent root.
- **Le transport.** TLS (rustls) sans aucun moyen de désactiver la vérification.
  Le `http://` en clair est refusé hors de la machine elle-même, sauf choix
  explicite à l'enrôlement (`--insecure-plaintext`), que l'interface signale. Le
  jeton voyage dans l'en-tête `Authorization`, jamais dans l'URL ; il expire à 30
  jours et le serveur le remplace à une connexion dans ses sept derniers jours
  (`token_hash_prev` garde l'ancien valable tant que le nouveau n'a pas servi).
  Tout refus ferme la socket
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
- **Les droits décidés sur la machine.** `[policy]` (douze interrupteurs :
  terminal, terminal root, lecture de fichiers, écriture de fichiers,
  alimentation, mises à jour de paquets, élévation du service,
  auto-destruction, Docker, déploiements Docker, CloudSync, tunnels) se fixe à
  la liaison (`--allow`, sans quoi rien n'est permis) et ne change que sur la
  machine (`deveye-agent policy`) ; aucun ordre du serveur n'y touche, et la
  rotation du jeton réécrit le fichier tel qu'il est sur disque. Un
  interrupteur absent du fichier vaut un refus. La fenêtre d'appairage propose
  « Surveillance seule » d'abord. La surveillance (mesures, rapports,
  inventaire Docker) n'est jamais refusée.
- **Le terminal root.** Un agent root ouvre un shell root, sauf si la session
  nomme un autre compte, qu'il rejoint par `su -l`. Ce shell exige
  l'interrupteur `terminal-root` en plus de `terminal` : sans lui, l'agent
  refuse une session sans compte, au nom de root ou d'un compte d'uid 0, ou
  dont le compte ne se résout pas, et l'interface demande un compte dans les
  réglages du terminal. Sous Windows, où le shell est toujours celui de
  l'agent, un agent élevé l'exige pour tout terminal. Un fichier qui ne porte
  pas cet interrupteur le refuse, comme tout interrupteur absent :
  `sudo deveye-agent policy --allow terminal-root`, sur la machine, le permet.
- **Le script d'installation** (`/install.sh`, `/install.ps1`) exécute ce que
  le serveur envoie : un serveur compromis servirait un script qui permet plus
  que les `--allow` demandés. Pour une machine où cela compte, le binaire publié et un `link`
  tapé à la main s'en passent. Il ne porte aucun secret ; l'origine y est
  validée avant d'être posée entre apostrophes.
- **L'auto-mise à jour** ne dépend pas du serveur : sha256 du binaire et
  signature Ed25519 de la CI, clé publique gravée à la compilation, échec fermé
  sans clé, et seule la cible de ce binaire se télécharge. Un serveur compromis
  ne pousse pas de binaire, ni une version qui ne soit pas plus récente que
  celle en marche : une plus ancienne ignorerait les interrupteurs ajoutés
  depuis, et une même version se construit plusieurs fois. Le serveur vérifie
  aussi la signature de chaque binaire avant de le garder ou de le pousser
  (`src/agent/signing.ts`) : une release altérée sur GitHub n'arrive pas
  jusqu'aux agents.
- **Les binaires ne portent aucune signature Windows ni Apple** : un
  téléchargement par le navigateur peut buter sur SmartScreen ou Gatekeeper.
  La fenêtre « Télécharger l'agent » donne l'empreinte SHA-256 du binaire
  enregistré, à comparer avant de le lancer.
- **Ce qui remonte.** Tout seul : métriques, programmes (nom, chemin, compte,
  jamais la ligne de commande ni l'environnement), ports et connexions, posture,
  matériel, et pour Sentinelle des empreintes et des issues d'authentification
  (voir [son README](../features/sentinel/README.md), dont ce qu'un compte local
  peut ou non lui faire croire). À la demande : journaux (des sources que l'agent
  découvre lui-même : journal système, quatre fichiers de `/var/log`,
  conteneurs ; jamais un chemin libre), fichiers, terminal. Rien de cela n'est
  persisté. La sortie d'un terminal, une liste de dossier, le résultat d'une
  recherche, les octets d'un fichier et les lignes d'un journal ne sont relayés
  qu'à la connexion qui les a demandés. L'état de Docker, des paquets et de
  l'alimentation est partagé entre ceux qui tiennent la permission de l'ordre
  sur cette machine (`DEVICE_EVENT_AUDIENCES`, `src/agent/hub.ts`) : la simple
  lecture d'Appareils ne donne que la télémétrie.
- **CloudSync** : la racine d'un partage est choisie côté serveur, sous un droit
  qui n'est pas celui du terminal. L'agent refuse un dossier système (`/root` et
  `/var/spool` compris), la racine, son propre dossier, un chemin qu'un lien
  symbolique ferait sortir du partage, et, si `sync_roots` est renseigné sur la
  machine, tout ce qui n'y figure pas. Dans un partage, il n'installe ce qui
  ouvrirait la machine (`.ssh`, les dossiers de démarrage de session ou de
  services de l'utilisateur, un fichier de démarrage du shell posé dans un
  foyer) que si le partage l'autorise, ce qu'il ne fait pas par défaut. Sans
  cette règle, écrire dans un partage vaudrait un terminal : l'autoriser exige
  donc le droit « Terminal distant » sur chaque appareil du partage et une
  confirmation récente, et un agent dont la politique refuse le terminal (le
  terminal root, pour un agent root) les refuse toujours. L'accord vaut pour quiconque écrit dans le partage.
- **Tunnels** : une connexion TCP que la machine ouvre pour un module (une base
  de données sur sa boucle locale), sous un droit d'Appareils qui n'est pas
  celui du terminal (« Accès au réseau de l'appareil »). L'agent ne joint que sa
  propre boucle locale, plus les hôtes que `tunnel_targets` nomme sur la
  machine, et refuse tout sous `allow_tunnel = false`. Ce que le serveur lit
  est borné par des crédits : un agent qui déborde voit son tunnel fermé.
- **Le service système** ne porte que `RestrictRealtime` et `LockPersonality` :
  tout ce que systemd confinerait de plus s'appliquerait au shell de l'opérateur
  et aux mises à jour de paquets, qui sont les enfants de l'agent.

## CloudSync : clé du serveur, ou chiffrement de bout en bout

Les contenus synchronisés (feature CloudSync) ne passent **pas** par le
chiffrement par enveloppe utilisateur : la synchro tourne en tâche de fond,
que la session soit verrouillée ou non, et des fichiers de plusieurs Go ne
peuvent pas vivre en base. Un partage se crée dans l'un de deux modes, pour
toujours.

### Standard : la clé du serveur

- les contenus vivent dans un **blob store** par partage, sur le disque du
  serveur ou dans le bucket S3 de l'hôte (`<storage_key>/blobs/…`), adressés
  par le SHA-256 de leur clair ; le bucket ne reçoit que des blobs déjà
  chiffrés, jamais la clé ;
- chaque blob est chiffré **AES-256-GCM** par une **BMK** (Blob Master Key,
  32 octets) générée au premier boot, wrappée par la clé serveur
  (`deps.keys.sealBytes`, soit `crypt.seal`, même schéma que le wrap des DEK)
  et rangée dans `sync_meta` : la rotation de `CRYPT_KEY_A/B` ne demande que de
  re-wrapper 32 octets, jamais de re-chiffrer les blobs ;
- l'index (chemins relatifs, hashes, tailles, mtimes, appareil source) est en
  clair dans MySQL, nécessaire au merge, à la navigation et à la volumétrie.

Le format de blob porte un octet de version : `0x01` (flux GCM unique) reste lu
pour toujours, `0x02` scelle par blocs de 1 Mio (nonce dérivé d'un compteur,
AAD = compteur + marqueur de fin contre la troncature) : c'est ce qui rend un
transfert interrompu reprenable sans jamais retransmettre les octets déjà reçus.

Ce que ça protège : le disque au repos (vol, snapshot hors-ligne), et le
bucket seul. Ce que ça ne protège pas : une compromission du serveur vivant,
ou la base et l'env ensemble (qui donnent la BMK). C'est le même niveau que
les secrets liés à l'auth (2FA). Le chiffrement côté fournisseur S3 (SSE)
n'y ajoute rien : les blobs arrivent déjà chiffrés, et le fournisseur
déchiffre pour quiconque présente les identifiants S3, que le serveur détient.

### De bout en bout : la clé des appareils

Le clair existe déjà sur les appareils : ce sont eux qui tiennent la clé.

- Le navigateur tire un secret de 20 octets à la création et l'affiche en
  **code de secours**. Le serveur n'en garde qu'un témoin (HKDF), qui dit si un
  code saisi est le bon et n'ouvre rien.
- Chaque agent tient une paire **X25519** (sa clé privée dans
  `sync-device.key`, à côté de sa config, lisible de son seul compte) et
  publie sa clé publique. Le navigateur y **scelle** le secret (X25519
  éphémère, HKDF, AES-GCM lié à l'id du partage) quand on attache l'appareil ;
  le serveur range et relaie cet exemplaire sans pouvoir l'ouvrir. Rien n'est
  saisi au démarrage de l'agent.
- L'agent **nomme** chaque contenu par HMAC-SHA256 sous une clé dérivée du
  secret (plus de SHA-256 du clair, ni en base ni dans le bucket) et **scelle**
  lui-même chaque blob (DEVB v3 : nonce aléatoire par bloc, AAD liant le bloc
  à son rang, à son blob et au nom du contenu). Le serveur stocke et relaie
  sans déchiffrer.
- Pourquoi pas le **mot de passe du compte** : le serveur le reçoit à chaque
  connexion (c'est lui qui déverrouille la DEK). Une clé qui en dériverait lui
  serait accessible.

Ce que ça protège : les contenus contre la base, l'env, le bucket et le
disque réunis, et contre un opérateur qui lit. Ce que ça ne protège pas :

- les **métadonnées** : chemins, tailles, dates et rythme des changements
  restent en clair, nécessaires au merge et à la navigation ;
- un **serveur actif** qui modifie le code servi au navigateur : il pourrait
  lire le code de secours au moment où on le tape. C'est la limite de tout
  chiffrement de bout en bout sur le web. L'agent, lui, n'exécute pas de code
  venu du serveur pour ce chiffrement, et aucune clé ne lui parvient sans
  avoir été scellée par un navigateur ;
- un **serveur actif** qui substitue la clé publique d'un appareil : le
  navigateur scelle le secret pour la clé que le serveur lui rend, sans
  empreinte à comparer sur la machine.

Ce que l'utilisateur perd : les sauvegardes (le module Sauvegardes ne
propose pas ces partages), l'export de compte (une note à la place des
fichiers), le contrôle d'intégrité complet côté serveur (la forme seulement),
et un téléchargement depuis le navigateur sans le code. Code perdu : les
appareils gardent la clé et les fichiers ; seuls le navigateur et l'ajout
d'un nouvel appareil deviennent impossibles.

**Pourquoi pas la DEK personnelle** : la DEK gardée est liée à une session
WebSocket vivante (fenêtre glissante, de 60 s par défaut, effacée à la fermeture de la
socket, jamais persistée) et le code la déclare structurellement inatteignable
sans session. Or une session CloudSync est pilotée par l'agent, sans aucune
session utilisateur. Un partage ainsi chiffré ne se synchroniserait que
pendant qu'un onglet est ouvert et déverrouillé.

## Hébergement, lisible par le serveur par construction

Le module Hébergement sert des fichiers à des visiteurs sans compte : le serveur
doit donc pouvoir les lire, et ils ne passent pas par l'étage gardé.

- Les octets vivent dans le magasin d'objets de l'hôte (disque, ou bucket
  `STORAGE_S3_*`), scellés au conteneur `DEVB` v2 par une clé du module.
  Toutes ses clés dérivent d'une racine de 32 octets tirée au sort au premier
  démarrage, scellée par la clé serveur dans `ft_hosting_key` : une rotation de
  la clé serveur la ré-emballe sans toucher aux fichiers
  ([KEY_ROTATION.md](./KEY_ROTATION.md)), et perdre `CRYPT_KEY_A/B` rend tous
  les fichiers hébergés illisibles. Le bucket ne reçoit que du chiffré, et un
  envoi est scellé dans le dossier local des envois avant d'y partir. La clé ne
  dépend d'aucun espace : partager ou déplacer un dossier ne relit pas un octet
  de fichier.
- Les noms des dossiers, sous-dossiers, fichiers et adresses sont chiffrés à l'étage
  ouvert de l'espace. L'unicité d'un nom dans son dossier tient à un condensat
  à clé (HMAC, clé du module), jamais au nom en clair.
- Le mot de passe d'une adresse est haché (scrypt, sel propre). L'accès qu'il
  ouvre est un cookie `HttpOnly`, `SameSite=Lax`, signé par une clé du module, qui
  porte son échéance (une journée) et la version du mot de passe : le changer ou
  le retirer ferme tous les accès ouverts.
- Les pages publiques n'ont aucun script (`default-src 'none'`, formulaires sur
  la même origine, `frame-ancestors 'none'`). Un fichier ne s'affiche dans le
  navigateur que pour les types qui ne peuvent pas exécuter de code (images,
  son, vidéo, texte brut, sous `CSP: sandbox`) et pour le PDF, que le lecteur du
  navigateur isole lui-même (il perd `sandbox`, mais ne s'intègre que dans une
  page de la même origine : `frame-ancestors 'self'` et
  `X-Frame-Options: SAMEORIGIN`), toujours avec `nosniff` ; tout le reste part
  en pièce jointe. Le téléchargement du propriétaire passe par un ticket, sur
  l'origine de l'app, toujours en pièce jointe.
- Les signalements sont scellés par la clé serveur (`keys.sealBytes`, liés à
  leur référence) : ils se lisent sans aucun espace, survivent au dossier, et ne
  sont jamais montrés à qui a publié le contenu signalé. Le module déclare leur
  colonne (`sealed`) : une rotation de la clé serveur les ré-emballe
  ([KEY_ROTATION.md](./KEY_ROTATION.md)).

## Tableau blanc : l'étage ouvert, et les images sous la clé du module

Un tableau se dessine à plusieurs : le serveur fusionne les éléments reçus et
écrit la scène sans session, donc à l'étage ouvert (`shareTier: 'open'`).

- Le titre, la scène (compressée avant scellement) et l'aperçu sont scellés à
  l'étage ouvert de l'espace d'origine du tableau, même quand on le dessine
  depuis un espace où il est projeté. Le déplacement les rescelle sous la clé
  de l'espace d'arrivée. Pendant une séance, la scène est en clair dans la
  mémoire du serveur. Le fond et le thème du tableau restent en clair : une
  couleur et un choix clair ou sombre, qui ne disent rien du dessin.
- Les images vivent dans le magasin d'objets, scellées au conteneur `DEVB` v2
  par une clé dérivée d'une racine tirée au sort au premier démarrage, scellée
  par la clé serveur dans `ft_whiteboard_key` (déclarée `sealed` : une rotation
  la ré-emballe, perdre `CRYPT_KEY_A/B` rend toutes les images illisibles). Ce
  niveau vaut l'étage ouvert, lisible sans mot de passe, mais avec deux écarts
  à connaître : les images ne sont pas séparées par la clé d'un espace, seulement
  par l'accès aux lignes qui les nomment (comme Hébergement), et une image
  retirée reste lisible jusqu'au balayage qui l'efface.
- La clé d'objet d'une image est tirée au sort et ne figure que dans sa ligne :
  elle ne se devine pas depuis l'identifiant du tableau, et une copie en reçoit
  une neuve. Copier et déplacer ne rechiffrent jamais une image.
- Les trames d'une séance ne vont qu'aux comptes qui y participent, sous la
  garde du droit de lecture de la salle. Un membre dont l'accès tombe pendant
  une séance peut encore recevoir des traits une vingtaine de secondes, le
  temps que sa présence, refusée, cesse de le tenir pour présent. Les curseurs,
  eux, ne circulent qu'entre les connexions que `whiteboard.join` a assises
  dans le canal du tableau, après les mêmes vérifications ; le hub les en sort
  quand elles quittent l'espace de leur siège ou perdent la lecture de la
  feature (`Docs/LIVE.md`).

## Uptime : l'étage ouvert appliqué à une tâche de fond

La feature Uptime (module `features/uptime/`, `src/server/service.ts` et
`src/server/handlers.ts`)
sonde des services HTTP **en continu, sans session ni mot de passe** : c'est le
serveur seul qui travaille, souvent alors que personne n'est connecté. Elle
utilise donc systématiquement l'**étage ouvert** :

- chiffrés (`ctx.cipher()` côté handlers, `deps.cipherFor()` côté ordonnanceur,
  qui n'expose _que_ cet étage, l'étage gardé n'ayant aucun sens sans session) : le nom
  du service, son URL, le mot-clé attendu, la référence et le verdict
  d'intégrité, les messages d'erreur (ligne du service, ligne de chaque ping,
  ligne d'incident) et les canaux de notification
  (libellé, adresse mail, URL de webhook) dans `notification_channels`
  (voir [NOTIFICATIONS.md](./NOTIFICATIONS.md)) ;
- en clair : ce qui pilote la planification (`interval_seconds`,
  `timeout_seconds`, `enabled`, `last_checked_at`, et le rythme de lecture des
  fichiers : `integrity_interval_seconds`, `integrity_checked_at`,
  `integrity_failures`) et ce qu'agrègent les
  graphiques (`status`, `response_ms`, `http_status`, horodatages, agrégat
  journalier). Aucune de ces colonnes ne dit _quoi_ est surveillé.

Même garantie que la BMK CloudSync : protégé au repos, lisible par un serveur
vivant compromis. Le choix est ici structurel : un moniteur qui exigerait le mot
de passe ne pourrait tout simplement pas sonder.

Le client bâti publie aussi `/.well-known/deveye-build.json`, l'empreinte
SHA-256 de chacun de ses fichiers actifs (HTML, scripts, styles, WebAssembly,
SVG ; ni polices ni images). Ce n'est pas une preuve (le serveur qui le
sert pourrait le réécrire) mais la liste de ce qu'un contrôle d'intégrité tenu
par une **autre** instance doit relire ; la référence, elle, est apprise et
gardée là-bas. Voir [le README d'Uptime](../features/uptime/README.md).

## Stores : des clés privées tierces à l'étage ouvert

Stores (module `features/appstores/`) relève les chiffres et les avis des apps
chez Apple et Google **sans session**, toutes les demi-heures. Il tient donc
à l'étage ouvert ce qui est sans doute le secret le plus puissant de l'app : une
clé d'API App Store Connect (le fichier `.p8`, souvent de rôle Admin, seul rôle
qui réponde aux avis) ou la clé privée d'un compte de service Google.

- chiffrés : la clé privée dans sa propre colonne (`secret_enc`), jamais rendue
  au client (qui n'en voit que `hasSecret`), omise de l'export du compte et de
  toute copie ; ce qui l'identifie sans être secret (Issuer ID, Key ID, numéro
  de fournisseur, adresse du compte de service, bucket) ; le nom de chaque app,
  son identifiant au store, ses versions ; le texte des avis, leur auteur et les
  réponses ;
- en clair : ce que les écrans agrègent (téléchargements, notes, taux de
  plantage, revenus par jour et par devise, note de chaque avis) et ce qui pilote
  la synchronisation. `external_ref`, le condensé de l'identifiant d'une app au
  store, ne sert qu'à refuser un doublon dans l'espace.

Les adresses contactées sont écrites en dur (`api.appstoreconnect.apple.com`,
`oauth2.googleapis.com`, `storage.googleapis.com` et les API Google Play) : le
`token_uri` d'un JSON de compte de service est ignoré, sans quoi l'utilisateur
choisirait où le serveur envoie une assertion signée. Le nom du bucket, le nom
de paquet et le numéro de fournisseur sont validés avant d'entrer dans un chemin.

Même garantie que pour Uptime : protégé au repos, lisible par un serveur vivant
compromis. La parade est du côté du store : une clé se révoque chez Apple ou
Google sans passer par DevEye. Voir [le README de Stores](../features/appstores/README.md).

## Projets : l'étage choisi par l'utilisateur

Contrairement à Uptime (toujours ouvert) et au coffre (toujours à l'étage
gardé, donc sous la clé de l'espace dans un espace partagé), les projets
laissent le choix **par projet** : `projects.security_tier` vaut `open` ou
`guarded`, exactement comme `mail_accounts.security_tier`. Comme pour une note
privée, la fenêtre de création ne propose le palier confidentiel qu'aux comptes
qui ont activé le chiffrement par mot de passe : sans lui, le projet s'ouvrirait
sans saisie et resterait lisible par le serveur.

Les étages vivent dans le module (`features/projects/src/server/_shared.ts`) :
`cipherFor(ctx, tier)` rend `ctx.cipher()` (l'étage ouvert) ou
`ctx.cipher('private')` (l'étage gardé, qui n'existe que dans une session
déverrouillée), `assertProjectUnlocked` interroge `ctx.secrecy.isUnlocked()`
avant une écriture qui n'a pas besoin de lire, et le service du module ne
connaît que `deps.cipherFor(ws)`, l'étage ouvert : ce qu'il offre aux autres
modules (`PROJECTS_USAGE_PROVIDER`) ne touche jamais un projet gardé.

Ce qui en découle :

- **Tout l'arbre d'un projet suit l'étage de son projet** : cartes, messages,
  jalons, événements d'historique (la liste est dans
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
  La règle est portée par la liaison elle-même : `projects.repoLink` et les
  autres commandes de liaison refusent un projet gardé, et passer un projet en
  gardé retire ses liaisons. Les services des modules Git et Déploiements n'ont
  donc jamais un
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
les siens) sont **toujours** sous l'étage ouvert, quel que
soit le tier des projets qui s'en servent : le service de fond doit les lire
sans session. Ils ne sont jamais renvoyés au client, qui n'en reçoit qu'un
booléen `hasSecret`.

## Ce que le serveur peut toujours lire

L'étage ouvert et la clé serveur portent tout ce dont un service de fond se
sert sans session. Aucun de ces identifiants n'est protégé par le chiffrement
par mot de passe : un serveur en marche les déchiffre seul, à tout moment. Les
formulaires où se saisissent les identifiants d'infrastructure (base, tunnel,
destination de sauvegarde, jeton, clé d'API, accès bancaire) le disent.

| Identifiant                                                       | Colonne                                                                                                 | Ce qui s'en sert sans session                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Mot de passe d'une base, mot de passe ou clé privée du tunnel SSH | `database_connections.secret_enc`, `access_secret_enc`                                                  | le relevé des bases suivies, la source « base » d'une sauvegarde |
| Secret d'une destination de sauvegarde (S3, SFTP, WebDAV)         | `backup_destinations.secret_enc`                                                                        | le planificateur de sauvegardes                                  |
| Identifiants IMAP et SMTP, jetons OAuth d'une boîte **ouverte**   | `mail_accounts.credentials_enc`                                                                         | la relève du courrier, l'envoi des alertes par mail              |
| URL de webhook, adresse d'alerte                                  | `notification_channels.target_enc`                                                                      | tout envoi d'alerte                                              |
| Jeton GitHub                                                      | `ft_git_credentials.secret_enc`                                                                         | le suivi des dépôts                                              |
| Identifiants Dokploy et GitHub Actions                            | `ft_deploy_credentials.secret_enc`                                                                      | le suivi et le lancement des déploiements                        |
| Clé `.p8` de l'App Store, clé de compte de service Google         | `ft_appstores_sources.secret_enc`                                                                       | la synchronisation des stores                                    |
| Accès bancaire (clé Qonto, session Enable Banking)                | `ft_finance_connections.content`                                                                        | le relevé des comptes                                            |
| Clés de fournisseurs (météo, NVD)                                 | `weather_provider_keys.key_enc`, `feature_kv`                                                           | les appels à ces services, l'ingestion des CVE                   |
| Secret TOTP, numéro de téléphone                                  | `user_2fa.secret_enc`, `user_phones.phone_sealed`                                                       | la connexion, avant toute session                                |
| Clés DKIM, clé de boîte, certificat TLS du serveur mail           | `ft_mailserver_domain_keys.private_key`, `ft_mailserver_mailboxes.blob_key`, `ft_mailserver_tls.sealed` | la réception et l'envoi du courrier hébergé                      |

Ce qui borne le dégât n'est donc pas le chiffrement mais le privilège donné :
un compte de base en lecture seule, un jeton GitHub limité aux dépôts suivis,
une clé S3 limitée à son préfixe. Une machine, elle, n'obéit qu'à la politique
locale de son agent, que le serveur ne peut pas élargir (voir [L'agent](#lagent)).

Ce que le serveur ne peut pas déchiffrer, session verrouillée : l'étage gardé
d'un espace personnel dont le compte a activé le chiffrement par mot de passe
(coffre, notes privées, projets confidentiels, boîtes mail protégées), et un
partage CloudSync chiffré de bout en bout.

## Ce qui reste en clair

Le chiffrement de DevEye est non déterministe : ce sur quoi une requête trie,
filtre, joint ou agrège ne peut pas le traverser. La règle, dans chaque
module : le **texte libre** (titres, intitulés, noms, notes, adresses,
identifiants) est chiffré ; les **nombres, dates, états et rattachements**
restent en clair. Qui lit la base sans la clé y voit donc la forme de
l'activité, pas son contenu.

- **Finances** : montants, TVA, dates, natures, pointage, rattachements à un
  compte ou à une catégorie, soldes d'ouverture et de clôture d'un relevé. Un
  solde et une répartition sont des `SUM(...) GROUP BY`. Chiffrés : intitulé,
  tiers, note, nom de compte, nom de catégorie, accès bancaires. Le journal
  d'audit ne porte pas les montants.
- **Facturation** : totaux, taux, quantités, prix unitaires, dates, statuts,
  numéros, devise. Chiffrés : identités et adresses de l'émetteur et du client,
  coordonnées bancaires, intitulés de ligne, références de paiement.
- **Projets** et **Git** : voir
  [Ce qui reste en clair, et pourquoi](#ce-qui-reste-en-clair-et-pourquoi).
- **Uptime** et **Stores** : voir leur section.
- **CloudSync** : le nom d'un partage, les chemins, les tailles, les dates, le
  dossier local de chaque appareil et le journal, y compris pour un partage de
  bout en bout. Seul le contenu des fichiers est chiffré.
- **Appareils** et **Sentinelle** : rien n'y est chiffré. Les rapports, les
  mesures, les processus et les constats sont des faits sur des machines, que
  le moteur lit sans session.
- **Météo** : le nom d'une ville et ses coordonnées.
- **Convertisseur** : le fichier envoyé et son résultat sont sur le disque du
  serveur, en clair, le temps de la conversion, puis une heure par défaut pour
  le résultat. Seuls leur nom et l'erreur éventuelle sont chiffrés en base.
- **Comptes et espaces** : nom d'utilisateur, adresse e-mail, avatar, nom d'un
  espace et de ses rôles, membres, adresses invitées, partages et droits.
- **Journaux** : le journal d'audit garde un an la description de chaque geste,
  qui cite des noms (un partage, une ville) et des chemins (un dossier parcouru,
  un fichier téléchargé ou écrit, un journal lu sur
  une machine), avec l'adresse IP. L'historique des connexions garde l'adresse
  IP quatre-vingt-dix jours.
- **Partout** : les identifiants de ligne, l'espace et le compte propriétaires,
  les dates de création et de modification, les tailles.

## Les condensés

Le chiffrement n'est pas déterministe : ce qui doit rester unique, ou se
retrouver sans être déchiffré, est doublé d'un condensé (`name_ref`,
`author_ref`…). Un condensé nu, un SHA-256 de la valeur, se recalcule par qui
devine la valeur : il confirme une hypothèse à quiconque lit la base, et un
membre peut comparer le sien à celui d'un autre espace.

La primitive `keys.ref` (`src/Services/refKeys.ts`) y répond : un HMAC-SHA256
sous une clé que seul le serveur détient, propre au module et à l'usage, et
lié à une portée (l'espace, l'élément) pour que la même valeur donne ailleurs
un condensé sans rapport. Sa racine est tirée au sort au premier démarrage et
scellée par la clé serveur (`server_ref_key`) ; le serveur refuse de démarrer
s'il ne sait pas l'ouvrir, plutôt que d'en tirer une autre.

Aujourd'hui, elle porte le condensé de l'identifiant saisi lors d'une connexion
ratée sur un compte inconnu (`usernameRef` au journal d'audit, où l'on tape
parfois son mot de passe par erreur) et le nom d'une base de données
(`database_connections.name_ref`, lié à l'espace). Les condensés de Git,
d'Audience, des Liens courts, des Stores et du module Audit sont encore des
SHA-256 nus.

Un condensé lié à un espace ne le quitte pas : une copie arrive avec ceux de
sa destination, un déplacement les recalcule. Les lignes écrites sous l'ancien
format sont reprises par une étape de données, au premier démarrage qui la
porte ; si la clé d'un espace ne s'ouvre pas, le serveur refuse de démarrer
plutôt que de laisser cet espace à l'ancien format.

## Ce que le serveur ne lit jamais

Au sens strict, celui où ni la clé ni le clair ne lui parviennent :

- **Le contenu d'un partage CloudSync de bout en bout.** La clé est tirée dans
  le navigateur et scellée pour chaque appareil (voir
  [De bout en bout](#de-bout-en-bout--la-clé-des-appareils)). Les métadonnées
  ci-dessus restent lisibles.
- **Un document travaillé dans l'atelier PDF.** Pages, signature, annotations,
  caviardage et mot de passe se font dans le navigateur, qui n'envoie rien.
  Deux exceptions : reconnaître le texte et alléger passent par le
  Convertisseur, donc par le serveur. Les signatures enregistrées, elles, sont
  gardées à l'étage ouvert.
- **Le moyen de paiement**, saisi chez le prestataire de paiement.

Rien d'autre. L'étage gardé n'en fait pas partie : le serveur le déchiffre
pendant qu'une session est déverrouillée.

## Ce qui est vérifié, et par qui

À chaque poussée : les tests unitaires du serveur, du client, des modules et de
l'agent ; un test qui confronte chaque requête des dépôts du socle à la garde
qu'elle déclare (espace, compte, appareil) ; un contrôle qui prépare, sur une
base MySQL jetable, chaque requête SQL que le serveur peut envoyer, puis relit
chacune et refuse celle qui cite une table d'espace sans la borner à un espace,
sauf dispense écrite avec sa raison ; un
passage qui ouvre chaque module dans un vrai navigateur ; et les parcours de
la page « Tests et débogage », joués par des comptes jetables sur un serveur
démarré pour l'occasion : inscription et suppression d'un compte, espace
partagé à deux, double authentification, code par mail, mot de passe oublié,
et ceux que les modules déclarent. Parmi eux, un parcours de cloisonnement par
module qui a déclaré ses sondes : un second compte y tente chaque commande à
identifiant du module, depuis un autre espace puis comme membre sans droit, et
tout doit lui être refusé sans rien rendre. Les modules du dépôt qui n'ont pas
encore leurs sondes sont nommés dans
`src/features/_sdk/register.isolation.test.ts`. Les avis de sécurité des crates de l'agent
et des paquets npm du serveur sont relus chaque semaine.

Ce qui lit une entrée écrite par quelqu'un d'autre est aussi éprouvé sur des
entrées tirées au hasard, cent par propriété à chaque poussée, cinq mille
chaque semaine sur une graine que personne n'a choisie : les commandes IMAP
d'un client de messagerie, l'arbre MIME d'un message reçu, les trames d'un
agent, un relevé bancaire importé, le corps d'un formulaire public. Les
propriétés sont les mêmes partout : rien ne lève hors de l'erreur prévue, ce
qui est rendu respecte le contrat qui le reçoit, et le coût reste borné par la
taille de l'entrée. Les autres lecteurs (types publics, agent, modules privés)
ne le sont pas encore.

L'interface a ses tests de composants, joués sans navigateur contre un serveur
de théâtre qui ne remplace que la socket : le reste du client tourne pour de
vrai. Deux composants en ont aujourd'hui, l'invite du mot de passe (il ne part
qu'une fois, et s'efface du champ sur tout échec) et la fenêtre d'appairage
d'un appareil (la commande à copier ne donne aucun droit sans un geste, et
porte exactement ceux qui sont cochés). Les autres sont nommés dans
`client/ui-tests.json`, une liste qui ne peut que raccourcir.

Ces contrôles sont écrits et tenus par le projet lui-même. Aucun tiers n'a
encore audité DevEye ni tenté de s'y introduire : les garanties de ce document
sont celles que le code et ses tests soutiennent, pas des garanties certifiées.
