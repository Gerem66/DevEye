# DevEye, le client

L'interface web de DevEye (React, Vite). Elle se lance depuis la racine du dépôt
avec `npm run dev` : Vite sert le client sur le port 5173 et proxifie `/api` et
`/ws` vers le serveur (port 3000). L'installation et le lancement sont décrits
dans le [README de la racine](../README.md#quick-start).

Dans ce dossier : `npm run lint`, `npm run typecheck`, `npm run gen:css-types`
(après tout ajout ou retrait de classe CSS), `npm run test:ui` (les tests de
composants, `*.test.tsx`), et `npm run ci` pour l'ensemble des contrôles. Un
composant nouveau arrive avec son test : voir « Tests et smoke » dans
[`Docs/FEATURE_SDK.md`](../Docs/FEATURE_SDK.md).
