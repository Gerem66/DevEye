# Systèmes de demande de mot de passe (DevEye client)

Répertoire des popups/gates d'authentification réutilisés dans l'app, pour
savoir lequel réutiliser au lieu d'en réinventer un.

## 1. `SecrecyGate` : déverrouillage du SecureStore (chiffrement par mot de passe)

- Fichier : `DevEye/client/src/Components/SecrecyGate/SecrecyGate.tsx`, monté
  une fois au niveau de l'app.
- Commande WS : `secrecy.unlock` (param `{ password }`, le mot de passe du
  compte ; l'espace visé voyage sur l'enveloppe, comme partout depuis le
  chantier des espaces).
- Rôle : déverrouille la **DEK gardée** de la session quand la feature
  « Chiffrement par mot de passe » est active (le SecureStore est verrouillé).
- Portée : session (DEK mise en cache côté serveur, fenêtre de grâce
  glissante, voir `@/stores/secrecy`).
- Helper d'usage : `ensureUnlocked()` de `@/stores/secrecy`, enrobé par
  `withSecrecy()` (réessai automatique sur code `locked`, fenêtre de grâce
  glissée à chaque action réussie). Le barrel `deveye-sdk-client` les
  réexporte pour les modules (`ensureSecrecyUnlocked`, `withSecrecy`).
- Annulation : `ensureUnlocked()` rejette une `UnlockCancelledError` (nom
  stable, `e.name === 'UnlockCancelledError'`, la classe n'étant pas exportée
  par le barrel) ; une feature qui n'a rien à montrer sans le mot de passe se
  referme dessus (le Coffre).
- Pattern : le store passe `prompting` à vrai, le dialogue s'ouvre, puis
  `resolveUnlock()` / `cancelUnlock()` libèrent les appelants en attente
  (plusieurs appels concurrents partagent la même invite).

Il n'existe **plus** de mot de passe par espace : l'ancien `popup-unlock`
(commande `password.unlock`, registre en mémoire par session côté serveur) a
disparu avec le rapatriement du Coffre en module, le 27 août 2026. Personne ne
l'ouvrait et il ne protégeait rien : la protection réelle est le chiffrement.

## 1 bis. `RemoteLogin` : connexion à une instance distante

- Fichier : `DevEye/client/src/Components/RemoteLogin/index.tsx`, monté une
  fois par l'accueil.
- Appels : `POST /api/auth/login` puis, si besoin, `POST /api/auth/2fa/challenge`
  sur l'**instance distante**, en transport porteur (`stores/remoteInstances.ts`,
  `loginRemote` / `submitRemoteTwoFactor`). Le serveur d'ici ne voit rien.
- Rôle : ouvrir la session du compte qu'on a là-bas. Ce n'est PAS le mot de
  passe du compte d'ici, ni celui du coffre : le coffre de l'instance distante
  se déverrouille ensuite par le prompt n°1, qui parle alors à cette instance.
- « Retenir sur cet appareil » garde le jeton de rafraîchissement dans le
  navigateur, jamais le mot de passe. Voir `FEDERATION.md`.

## 1 ter. Mot de passe d'un geste sur le compte : suppression et export

- Fichiers : `DevEye/client/src/Features/Profile/DeleteAccountDialog.tsx` et
  `ExportDataDialog.tsx`, dans la carte « Vos données » du Profil.
- Commandes WS : `user.deleteAccount` et `user.exportPrepare`, même compteur d'essais
  (`verifyPassword`), envoyées sur `ws.connectionFor(null)` : le compte visé est
  toujours celui de cette instance, même quand un espace distant est ouvert.
- Ce n'est pas un déverrouillage : l'export reçoit une DEK prêtée à lui seul
  (voir `SECURITY_MODEL.md`, « La DEK prêtée à une exportation »), la session
  reste verrouillée.

## 2. Notes privées — **aucun prompt dédié**

Les notes n'ont plus de mot de passe par note : une note marquée « privée » est
simplement chiffrée avec la DEK gardée au lieu de la DEK ouverte
(cf. `SECURITY_MODEL.md`). Elle réutilise donc **le prompt n°1** —
via `withSecrecy()` sur `notes.get`/`add`/`edit`/`delete`, ou explicitement via le
bouton « Déchiffrer » de la liste (`ensureUnlocked()` puis re-listage).

Les popups `popup-note-lock` / `-lock-set` / `-lock-manage` et l'ancien système
« notes masquées » (`note.reveal`) ont été supprimés.

## Composant sous-jacent

Le prompt n°1 est un `Dialog` piloté par le store `@/stores/secrecy`, pas un
`Popup` : c'est le store qui l'ouvre, et personne n'a d'identifiant à connaître.
Les formulaires des features (ajout d'un mot de passe, d'un compte mail) suivent
eux le contrat du composant `@/Components/Popup` : `OpenPopup(id, input)`
(résout au close) / `ClosePopup(id, result)`.

Même réutilisation partout ailleurs : une boîte mail « protégée », l'historique
OSINT verrouillé, une note privée passent tous par `withSecrecy()` et donc par
le prompt n°1. Il n'existe aucun autre prompt de mot de passe dans l'app.

## Modèle de sécurité global

Voir `SECURITY_MODEL.md` (envelope encryption, DEK, « Chiffrement par mot de
passe »).
