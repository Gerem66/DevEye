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

## "Chiffrement par mot de passe" (la feature UI)

Nom côté interface du fait de passer `wrap_mode` de `server` à `password`.
Handlers dans `src/features/secrecy/index.ts`. Quand elle est **ON** :

- Le déverrouillage de session (saisie du mot de passe → DEK déballée en mémoire)
  passe par le **`SecureStore`** : `ctx.secure.isUnlocked()` /
  `isUnlockedPassive()`.
- La DEK déverrouillée est cachée par `sessionId` dans une Map en mémoire
  (`sessionDeks`), jamais persistée, effacée à la déconnexion.
- **Fenêtre de grâce glissante** (`reAuthInterval`, en secondes ; défaut
  `DEFAULT_DEK_GRACE_MS` = 60 s ; `0` = re-prompt à chaque action). Chaque accès
  réarme le minuteur. Passé ce délai d'inactivité, la DEK est effacée et la
  prochaine action chiffrée redemande le mot de passe.
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

## Notes masquées ("hidden") — root auth

Indépendant du chiffrement ci-dessus. Une note avec le flag `hidden` exige une
autorisation de session ("root auth") via la commande **`note.reveal`**
(`src/features/note/index.ts`), qui vérifie le mot de passe du compte. Quand le
chiffrement par mot de passe est ON et la session déverrouillée, la DEK vivante
vaut elle-même preuve (pas de re-prompt). Une note hidden non autorisée est
renvoyée en **summary masqué** (`locked`) : métadonnées seules, body jamais
déchiffré côté serveur.

## Authentification

- Mots de passe hachés en **Argon2id** (`src/auth/argon.ts`), upgrade
  transparent des anciens hash bcrypt au login.
- Sessions par JWT (access + refresh en cookies), `sessionId` partagée entre le
  monde HTTP (login) et le monde WS (features). C'est cette `sessionId` qui relie
  le pré-cache de la DEK au login à la session WS qui l'utilisera.
- 2FA TOTP optionnel avec codes de secours à usage unique.
