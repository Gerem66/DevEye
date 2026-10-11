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
- Appels : `POST /api/auth/login` puis, pour chaque étape demandée (code par
  mail, application, SMS), `POST /api/auth/login/verify` sur l'**instance
  distante**, en transport porteur (`client/src/stores/remoteInstances.ts`,
  `loginRemote` / `submitRemoteCode`). Le serveur d'ici ne voit rien. La
  confiance accordée à ce navigateur là-bas se garde dans le même coffre du
  navigateur que le jeton de rafraîchissement.
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

## 1 quater. `StepUpGate` : le code avant de piloter une machine

- Fichier : `client/src/Components/StepUpGate/StepUpGate.tsx`, monté une fois
  au niveau de l'app, store `client/src/stores/stepUp.ts`.
- Déclencheur : un refus `stepup_required` sur n'importe quelle commande,
  intercepté par `DevEyeWs.send` (`client/src/api/ws.ts`) : aucun site d'appel
  ne l'enrobe, les modules compris. Le code confirmé (`stepup.confirm`, sur la
  connexion qui l'a demandé), la commande repart une seule fois ; l'invite
  fermée, elle rend le refus d'origine.
- Saisie : le code à six chiffres de l'application, ou un code de secours
  (`AuthenticatorCodeField` de `client/src/Components/CodeInput`, le champ de
  toute saisie de code de la 2FA). Sans application, l'invite l'explique et
  ouvre Sécurité.
- Ce n'est pas un mot de passe et ne déverrouille aucune donnée : voir
  [SECURITY_MODEL.md](./SECURITY_MODEL.md#lagent).

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
par l'invite n°1. Il n'existe aucune autre invite de mot de passe dans l'app,
hors des gestes de compte (n° 1 ter, mise en place de la 2FA dans Sécurité).

## Modèle de sécurité global

Voir [SECURITY_MODEL.md](./SECURITY_MODEL.md) (chiffrement par enveloppe, DEK,
« Chiffrement par mot de passe »).
