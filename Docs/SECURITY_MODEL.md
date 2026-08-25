# Modèle de sécurité — DevEye

Référence des mécanismes de chiffrement et d'authentification de l'app. À garder
à jour quand ces flux changent.

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
      **Argon2id**. Le serveur ne peut alors plus lire les données sans le mot de
      passe vivant.
- Activer/désactiver la feature ou changer de mot de passe **ne réécrit jamais**
  le contenu chiffré : on ré-emballe seulement la DEK.
- Un **code de récupération** optionnel peut aussi déballer la DEK (filet de
  sécurité), stocké dans `recovery_wrapped`.

**Conséquence importante :** rien n'est jamais stocké en clair en BDD. Même
feature OFF, les données sont chiffrées (DEK distincte par user) ; seul le niveau
d'emballage de la DEK change.

### Les deux étages : DEK « gardée » et DEK « ouverte »

`ctx.secure` expose **deux** codecs (`Cipher`), chacun adossé à une clé
différente — c'est le choix du codec qui fait le contrôle d'accès :

| Étage | Clé | Emballage | Lisible sans mot de passe ? |
| --- | --- | --- | --- |
| `ctx.secure` (gardé) | `dek_wrapped` | `server` **ou** `password` | non quand la feature est ON |
| `ctx.secure.open` | `open_dek_wrapped` | **toujours** `server` | oui, toujours |

La DEK ouverte est une seconde clé aléatoire par utilisateur, créée
paresseusement à la première écriture ouverte et **jamais** ré-emballée par les
handlers `secrecy` : activer le chiffrement par mot de passe ne doit pas
verrouiller cet étage. Elle sert aux données qu'une feature doit pouvoir servir
sans le moindre prompt tout en restant chiffrées au repos — au prix assumé que
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
  mot de passe.
- **`reAuthInterval = 0` = validation à chaque action.** La DEK n'est pas mise en
  cache d'une action à l'autre, mais l'unlock et l'action déclenchée sont deux
  commandes WS distinctes : la DEK déballée est donc gardée en **usage unique**
  (`singleUse`, non glissante) le temps de servir cette/ces commande(s), puis
  effacée dès que la rafale se vide. Le dispatcher compte les commandes en vol
  (`enterSessionCommand`/`exitSessionCommand`) : la DEK part quand le dernier
  consommateur termine — ce qui couvre les rafales concurrentes (ex. `note.list`
    - `folder.list`). Un court pont (`SINGLE_USE_BRIDGE_MS` = 30 s) borne un unlock
      jamais consommé. **Côté client**, le store secrecy passe en mode `singleUse` :
      la session n'est jamais tenue pour « déverrouillée », chaque action chiffrée
      redemande le mot de passe.
- Un handler verrouillé renvoie `FeatureError('locked')` → le client affiche le
  prompt de mot de passe habituel.

## Pré-cache de la DEK au login

Pour éviter de saisir le mot de passe deux fois d'affilée (login, puis unlock),
la DEK est déballée **au moment du login** (route `POST /api/auth/login`, où le
mot de passe est disponible en clair) et cachée sous la `sessionId` émise, via
`rememberSessionDek`. Voir `unwrapDekForLogin` dans `src/auth/routes.ts`.

- Ne se déclenche **que** si la feature est ON **et** `reAuthInterval > 0`.
- **Ne se déclenche jamais** au F5 / auto-login : ces flux réutilisent le cookie
  d'accès et n'appellent jamais `/api/auth/login`, donc aucune DEK n'est
  pré-cachée — le serveur redemande alors le mot de passe (comportement voulu).
- **2FA :** la session n'existe qu'après l'étape TOTP. La DEK déballée au login
  est gardée côté serveur dans un _pending store_ (`stashPendingDek`) sous un
  token opaque transporté dans le challenge JWT (champ `pdk`, jamais le mot de
  passe lui-même). L'étape TOTP la réclame (`claimPendingDek`) et la lie à la
  session émise. Nettoyage du matériel crypto en attente :
    - les entrées expirent (≤ fenêtre du challenge 2FA, sweep paresseux) ;
    - un nouveau login purge les pending DEK du même user (`stashPendingDek`
      appelle `discardPendingDeksForUser`) — couvre "Retour puis re-login" ;
    - le bouton "Retour" du prompt 2FA appelle `POST /api/auth/2fa/cancel` qui
      efface le cookie de challenge et `discardPendingDek` (libération immédiate) ;
    - une 2FA désactivée entre les deux étapes libère aussi la DEK.

## Notes privées

Application directe des deux étages ci-dessus (`src/features/note/index.ts`) :

- la feature Notes **s'ouvre sans mot de passe**. Corps des notes ordinaires et
  noms de dossiers vivent dans l'étage **ouvert** ;
- une note avec le drapeau clair `notes.is_private` a son corps chiffré par la
  DEK **gardée**. Il n'y a aucun contrôle d'accès par-dessus : c'est le
  chiffrement lui-même qui protège, et le serveur ne peut pas la déchiffrer sans
  mot de passe vivant ;
- `note.list` n'est jamais bloquée : une note privée sortie session verrouillée
  est renvoyée en **summary masqué** (`masked: true`) — métadonnées claires
  seules (id, dossier, rang, dates), jamais de titre ni de corps. Le client
  affiche un cadenas et propose « Déchiffrer », qui n'est que le prompt de
  déverrouillage global suivi d'un re-listage ;
- basculer le drapeau depuis l'éditeur **re-chiffre** la note dans l'autre étage
  à l'enregistrement ;
- `note.edit` / `note.archive` / `note.restore` / `note.delete` sur une note
  privée exigent en plus une session déverrouillée : ces chemins n'ont pas besoin
  de *lire* le corps, sans ce garde une session verrouillée pourrait écraser,
  escamoter ou détruire ce qu'elle ne voit pas. `note.reorder` (positionnement
  pur, n'expose ni ne réécrit le corps) reste libre, même sur une note masquée.

Remplace l'ancien système de verrou par note (mot de passe dédié par note,
`notes.lock_hash`), supprimé — un mot de passe par note n'était pas retenable.

## Authentification

- Mots de passe hachés en **Argon2id** (`src/auth/argon.ts`), upgrade
  transparent des anciens hash bcrypt au login.
- Sessions par JWT (access + refresh en cookies), `sessionId` partagée entre le
  monde HTTP (login) et le monde WS (features). C'est cette `sessionId` qui relie
  le pré-cache de la DEK au login à la session WS qui l'utilisera.
- 2FA TOTP optionnel avec codes de secours à usage unique.

## CloudSync — exception assumée au zero-knowledge

Les contenus synchronisés (feature CloudSync) ne passent **pas** par le
chiffrement par enveloppe utilisateur : la synchro tourne en tâche de fond,
que la session soit verrouillée ou non, et des fichiers de plusieurs Go ne
peuvent pas vivre en base. À la place :

- les contenus vivent dans un **blob store disque** par partage
  (`<storage_path>/blobs/…`), adressés par le SHA-256 de leur clair ;
- chaque blob est chiffré **AES-256-GCM en flux** par une **BMK** (Blob Master
  Key, 32 octets) générée au premier boot, wrappée par la clé serveur
  (`Encryption.encryptWithKey(crypt.serverKey(), bmk)`, même schéma que le
  wrap des DEK) et rangée dans `sync_meta` — la rotation de `CRYPT_KEY_A/B` ne
  demande que de re-wrapper 32 octets, jamais de re-chiffrer les blobs ;
- l'index (chemins relatifs, hashes, tailles, mtimes, appareil source) est en
  clair dans MySQL — nécessaire au merge, à la navigation et à la volumétrie.

Le format de blob porte un octet de version : `0x01` (flux GCM unique) reste lu
pour toujours, `0x02` scelle par blocs de 1 Mio (nonce dérivé d'un compteur,
AAD = compteur + marqueur de fin contre la troncature) — c'est ce qui rend un
transfert interrompu reprenable sans jamais retransmettre les octets déjà reçus.

**Pourquoi pas la DEK personnelle**, question tranchée et close : la DEK gardée
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
cran en dessous des données « mot de passe »/notes — documenté ici pour que le
choix reste explicite. Détails d'implémentation du format de conteneur :
`src/backup/devb.ts`.

## Uptime — l'étage ouvert appliqué à une tâche de fond

La feature Uptime (`src/Services/UptimeMonitor.ts`, `src/features/uptime/`)
sonde des services HTTP **en continu, sans session ni mot de passe** : c'est le
serveur seul qui travaille, souvent alors que personne n'est connecté. Elle
utilise donc systématiquement l'**étage ouvert** :

- chiffrés (`ctx.secure.open`, ou `createOpenCipher()` côté ordonnanceur, qui
  n'expose *que* cet étage — l'étage gardé n'a aucun sens sans session) : le nom
  du service, son URL, le mot-clé attendu, les messages d'erreur (ligne du
  service, ligne de chaque ping, ligne d'incident) et les canaux de notification
  — libellé, adresse mail, URL de webhook, dans `notification_channels`
  (voir [NOTIFICATIONS.md](./NOTIFICATIONS.md)) ;
- en clair : ce qui pilote la planification (`interval_seconds`,
  `timeout_seconds`, `enabled`, `last_checked_at`) et ce qu'agrègent les
  graphiques (`status`, `response_ms`, `http_status`, horodatages, agrégat
  journalier). Aucune de ces colonnes ne dit *quoi* est surveillé.

Même garantie que la BMK CloudSync : protégé au repos, lisible par un serveur
vivant compromis. Le choix est ici structurel — un moniteur qui exigerait le mot
de passe ne pourrait tout simplement pas sonder.

## Projets — l'étage choisi par l'utilisateur

Contrairement à Uptime (toujours ouvert) et au coffre (toujours gardé), les
projets laissent le choix **par projet** : `projects.security_tier` vaut `open`
ou `guarded`, exactement comme `mail_accounts.security_tier`.

Ce qui en découle :

- **Tout l'arbre d'un projet suit l'étage de son projet** — cartes, messages,
  jalons, événements d'historique, cache git, déploiements. Pas de tier par
  ligne : c'est ce qui rend la bascule atomique (`reencryptProjectTree`), qui
  lit et re-chiffre tout **avant** la moindre écriture et abandonne sans rien
  toucher si une seule ligne résiste.
- **`guarded` n'existe qu'en espace personnel.** En espace partagé, les deux
  étages utilisent la clé de l'espace : le projet serait lisible par tous tout
  en s'annonçant confidentiel. Refus explicite plutôt que ce mensonge. Un
  espace partagé reste chiffré — sous la clé de l'espace, à l'étage ouvert.
- **Un projet gardé perd ses intégrations.** La synchronisation git et le suivi
  de déploiement tournent sans session : ils n'atteindront jamais l'étage gardé.
  La règle est portée par la requête d'ordonnancement elle-même, pas par une
  garde applicative, pour qu'elle ne puisse pas être contournée par un nouvel
  appelant.

### Ce qui reste en clair, et pourquoi

Le module en garde plus que les autres, à dessein : ce sont les colonnes sans
lesquelles il faudrait déchiffrer des dizaines de milliers de lignes pour
afficher un écran.

- **`assignee_user_id`** — « toutes mes tâches, tous projets » en une requête.
  Le serveur connaît déjà l'appartenance à l'espace : il n'apprend rien de neuf.
- **`message_count` et le point d'eau haute de lecture** — le badge « des
  messages non lus ici » sans ouvrir un seul message.
- **`committed_at` et `author_ref`** — le graphe des commits est une agrégation
  SQL. `author_ref` est un condensé de l'adresse e-mail (16 caractères de son
  sha256) : identité stable et graine de couleur, **sans adresse en clair**.
- **Les dates, `archived_at`, `counts_as_done`** — la frise, les retards et
  l'avancement, tous calculés sans clé.

Aucune de ces colonnes ne dit *quoi* est fait, par qui hors de l'espace, ni ce
qui est écrit. Les titres, descriptions, messages, noms de branches et messages
de commit passent tous par le chiffre.

> **Corollaire à ne pas oublier** : le chiffrement est non déterministe, donc ce
> qui doit être **unique** ne peut pas être chiffré. D'où les colonnes `*_ref`
> (`author_ref`, `name_ref`, `tag_ref`) — des condensés stables qui portent
> l'unicité pendant que la valeur lisible vit dans le payload chiffré.

Les secrets d'accès (`project_credentials.secret_enc` : jeton GitHub, clé
Dokploy) sont **toujours** sous l'étage ouvert, quel que soit le tier des projets
qui s'en servent — le service de fond doit les lire sans session. Ils ne sont
jamais renvoyés au client, qui n'en reçoit qu'un booléen `hasSecret`.
