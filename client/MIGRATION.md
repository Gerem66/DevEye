# Plan de migration Interface — Phase 3B

Phase 3A (terminée) : infrastructure API côté React.

- `src/api/http.ts` — client HTTP cookie-based avec validation `zod` des
  réponses (`/api/auth/login|refresh|logout|me`). Lève `ApiError` typé.
- `src/api/ws.ts` — client WebSocket avec dispatcher requestId, validation
  envelope, reconnect backoff, send typé via `featureCommandRegistry`.
- `src/auth/AuthProvider.tsx` — Context React avec `useAuth()` exposant
  `user`, `workspaces`, `login`, `logout`, `refresh`. Tente un `/me` au mount,
  refresh transparent sur 401.

## Reste à faire — UI (Phase 3B)

Les pages/composants suivants utilisent encore l'ancien protocole et des types
renommés (`DBType_User`, `DBType_Workspace`, `FeatureType`, `FeaturesID`,
`PasswordType`, `FeatureProps`, `UserType`, `Endpoints`, `EndpointTypes`,
`RequestCommands`, `TCPRequestReceiveHeader`). Ces types n'existent plus dans
`deveye-types@0.2.0`.

À supprimer purement :

- `src/Utils/Storage.ts` — stockage `token` en localStorage (auth est cookie
  HttpOnly maintenant).
- `src/Utils/Request.ts` — utilise `Endpoints`/`EndpointTypes` (PHP).
- `src/Utils/TCP.ts` — protocole TCP ad hoc, remplacé par `src/api/ws.ts`.
- `src/Pages/Login/back.ts` — class component à remplacer par un fonctionnel
  hook `useAuth().login`.

À réécrire (mapping des types) :

| Ancien                       | Nouveau (`deveye-types`)                |
| ---------------------------- | ---------------------------------------- |
| `UserType`, `DBType_User`    | `User`                                   |
| `DBType_Workspace`           | `Workspace`                              |
| `FeatureType`, `FeaturesID`  | descriptor `featureCommandRegistry`      |
| `FeatureProps`               | à concevoir : un type local de Layout    |
| `PasswordType`               | `PasswordEntry` (+ `PasswordEntryMasked`)|

Pages/composants à migrer :

- `src/App.tsx` — wrap dans `<AuthProvider>`, router sur `status`.
- `src/Pages/Login/index.tsx` + `back.ts` — fonctionnel + `useAuth`.
- `src/Pages/Home/{index,popup-add-workspace,popup-unlock}.tsx`
- `src/Components/{Header,Navbar/back,Navbar/sections/*}`
- `src/Features/{Dashboard,GameLife,Password,Profile}/...`

Toutes les commandes WS doivent passer par `ws.send('workspace.add', input)`
etc., qui valide automatiquement input/output.

## Hors-scope tant que migration UI pas faite

- Tauri shell : voir `DevEye/client/`.
- Theming : conserver `Styles/*.css`.
