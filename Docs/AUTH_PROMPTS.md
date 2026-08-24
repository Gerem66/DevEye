# Systèmes de demande de mot de passe (DevEye client)

Répertoire des popups/gates d'authentification réutilisés dans l'app, pour
savoir lequel réutiliser au lieu d'en réinventer un.

## 1. `popup-unlock` — déverrouillage du SecureStore (chiffrement par mot de passe)

- Fichier : `DevEye/client/src/Pages/Home/popup-unlock.tsx`
- Commande WS : `password.unlock` (param `{ password }` ; l'espace visé voyage
  sur l'enveloppe, comme partout depuis le chantier des espaces)
- Rôle : déverrouille le **DEK** d'un workspace quand la feature « Chiffrement
  par mot de passe » est active (le SecureStore est verrouillé).
- Portée : session (DEK mis en cache, fenêtre de grâce — voir `@/stores/secrecy`).
- Helper d'usage : `ensureUnlocked()` / `touchSecrecy()` de `@/stores/secrecy`,
  enrobé côté features par `withSecrecy()` (retry auto sur code `locked`).
- Pattern : `OpenPopup('popup-unlock')` / `ClosePopup('popup-unlock', true)`.

## 2. Notes privées — **aucun prompt dédié**

Les notes n'ont plus de mot de passe par note : une note marquée « privée » est
simplement chiffrée avec la DEK gardée au lieu de la DEK ouverte
(cf. `SECURITY_MODEL.md`). Elle réutilise donc **le prompt n°1** —
via `withSecrecy()` sur `note.get`/`add`/`edit`/`delete`, ou explicitement via le
bouton « Déchiffrer » de la liste (`ensureUnlocked()` puis re-listage).

Les popups `popup-note-lock` / `-lock-set` / `-lock-manage` et l'ancien système
« notes masquées » (`note.reveal`) ont été supprimés.

## Composant sous-jacent

Tous suivent le contrat du composant `@/Components/Popup` :
`OpenPopup(id, input)` (résout au close) / `ClosePopup(id, result)`.

Même réutilisation partout ailleurs : une boîte mail « protégée », l'historique
OSINT verrouillé, une note privée passent tous par `withSecrecy()` et donc par
le prompt n°1. Il n'existe aucun autre prompt de mot de passe dans l'app.

## Modèle de sécurité global

Voir `SECURITY_MODEL.md` (envelope encryption, DEK, « Chiffrement par mot de
passe »).
