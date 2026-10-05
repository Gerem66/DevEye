# Les demandes de mot de passe du client

Répertoire des invites et des gardes d'authentification de l'app, pour réutiliser
celle qui existe au lieu d'en écrire une.

## 1. `SecrecyGate` : déverrouillage du coffre (chiffrement par mot de passe)

- Fichier : `client/src/Components/SecrecyGate/SecrecyGate.tsx`, monté une fois
  au niveau de l'app.
- Commande WS : `secrecy.unlock` (entrée `{ password }`, le mot de passe du
  compte ; l'espace visé voyage sur l'enveloppe, comme pour toute commande).
- Rôle : déverrouille la **DEK gardée** de la session quand « Chiffrement par
  mot de passe » est actif (le `SecureStore` est verrouillé).
- Portée : la session (DEK en cache côté serveur, fenêtre de grâce glissante ;
  voir `client/src/stores/secrecy.ts` et
  [SECURITY_MODEL.md](./SECURITY_MODEL.md)).
- Helpers : `ensureUnlocked()` du store, enrobé par `withSecrecy()` : sur un
  refus `locked`, le store passe verrouillé, l'invite s'ouvre et la requête est
  rejouée une fois ; chaque action réussie fait glisser la fenêtre de grâce. Le
  barrel `deveye-sdk-client` les réexporte pour les modules
  (`ensureSecrecyUnlocked`, `withSecrecy`, `useSecrecy`,
  `UnlockCancelledError`).
- Annulation : `ensureUnlocked()` rejette une `UnlockCancelledError` (exportée
  par le barrel ; `e.name === 'UnlockCancelledError'` reste un test stable) ;
  une feature qui n'a rien à montrer sans le mot de passe se referme dessus
  (Mots de passe).
- État : le store suit les avis `secrecy.state` du serveur et relit le statut à
  chaque connexion ; une feature qui affiche du contenu déchiffré lit
  `useSecrecy()` et se vide quand `unlocked` retombe (Notes, Mots de passe).
- Mécanique : le store passe `prompting` à vrai, le dialogue s'ouvre, puis
  `resolveUnlock()` / `cancelUnlock()` libèrent les appelants en attente
  (plusieurs appels concurrents partagent la même invite).

Il n'y a pas de mot de passe par espace : la protection réelle est le
chiffrement.

## 1 bis. `RemoteLogin` : connexion à une instance distante

- Fichier : `client/src/Components/RemoteLogin/index.tsx`, monté une fois par
  l'accueil.
- Appels : `POST /api/auth/login` puis, si besoin, `POST /api/auth/2fa/challenge`
  sur l'**instance distante**, en transport porteur
  (`client/src/stores/remoteInstances.ts`, `loginRemote` /
  `submitRemoteTwoFactor`). Le serveur d'ici ne voit rien.
- Rôle : ouvrir la session du compte qu'on a là-bas. Ce n'est ni le mot de
  passe du compte d'ici, ni celui du coffre : le coffre de l'instance distante
  se déverrouille ensuite par l'invite n°1, qui parle alors à cette instance.
- « Retenir sur cet appareil » garde le jeton de rafraîchissement dans le
  navigateur, jamais le mot de passe. Voir [FEDERATION.md](./FEDERATION.md).

## 1 ter. Mot de passe d'un geste sur le compte : suppression et export

- Fichiers : `client/src/Features/Profile/DeleteAccountDialog.tsx` et
  `ExportDataDialog.tsx`, dans la carte « Vos données » du Profil.
- Commandes WS : `user.deleteAccount` et `user.exportPrepare`, même compteur
  d'essais (`verifyPassword`), envoyées sur `ws.connectionFor(null)` : le compte
  visé est toujours celui de cette instance, même quand un espace distant est
  ouvert.
- Ce n'est pas un déverrouillage : l'export reçoit une DEK prêtée à lui seul
  (voir [SECURITY_MODEL.md](./SECURITY_MODEL.md#la-dek-prêtée-à-une-exportation)),
  la session reste verrouillée.

## 2. Notes privées : aucune invite dédiée

Une note marquée « privée » est chiffrée avec la DEK gardée au lieu de la DEK
ouverte (voir [SECURITY_MODEL.md](./SECURITY_MODEL.md)). Elle réutilise donc
**l'invite n°1**, via `withSecrecy()` sur `notes.list`, `notes.get`,
`notes.add`, `notes.edit` et `notes.archive`, ou explicitement par le bouton
« Déchiffrer » de la liste (`ensureUnlocked()` puis re-listage).

## Composant sous-jacent

L'invite n°1 est un `Dialog` piloté par le store `client/src/stores/secrecy.ts`,
pas un `Popup` : c'est le store qui l'ouvre, et personne n'a d'identifiant à
connaître. Les formulaires des features (ajout d'un mot de passe, d'un compte
mail) suivent eux le contrat du composant `client/src/Components/Popup` :
`OpenPopup(id, input)` (résout à la fermeture) / `ClosePopup(id, result)`.

Même réutilisation partout ailleurs : une boîte mail à l'étage gardé,
l'historique OSINT, une note privée passent tous par `withSecrecy()` et donc
par l'invite n°1. Il n'existe aucune autre invite de mot de passe dans l'app.

## Modèle de sécurité global

Voir [SECURITY_MODEL.md](./SECURITY_MODEL.md) (chiffrement par enveloppe, DEK,
« Chiffrement par mot de passe »).
