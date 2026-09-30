# Créer une nouvelle fonctionnalité — checklist complète

> **Une nouvelle feature se fait en module, sans exception.** Passe par le
> **SDK des modules** : repo
> [DevEye-Feature-Template](https://github.com/Gerem66/DevEye-Feature-Template)
> (doc anglaise complète) côté développeur, [FEATURE_SDK.md](./FEATURE_SDK.md)
> côté mainteneur. Les seize features (Météo, OSINT, Finances, le Coffre, les
> Notes, Uptime, Sentinelle, les Sauvegardes, les Bases de données, les
> Déploiements, Git, Audience, Mail, Projets et, en dernier, Appareils) sont
> au format module dans `features/*`, CloudSync en module privé. **Plus
> aucune feature n'est native.**
>
> La checklist ci-dessous décrit le chemin **natif** (`src/features/`,
> `defineFeature`, `FeatureContext`). Il n'a plus d'occupant parmi les
> features : il ne sert qu'aux **commandes transversales de l'app**, celles
> qui ne relèvent d'aucune feature d'espace et gardent un accès à tout le
> contexte (`workspace.*`, `user.*`, `admin.*`, `secrecy.*`, `twofa.*`,
> `notify.*`, `share.*`, `logs.*`, `home.*`, `live.here`) et au **transport
> des agents** (`agent.*`, des relais du hub, voir
> [Appareils](../features/devices/README.md)). Suis-la pour ajouter une commande à
> l'app elle-même ; pour tout ce qui a un widget, une page ou des données
> d'espace, c'est un module.

Ce document liste **tout** ce qu'implique l'ajout d'une fonctionnalité dans DevEye,
dans l'ordre, à travers les trois bases de code. Suis-le de haut en bas pour ne
rien oublier.

> **Deux types de « feature » à ne pas confondre :**
>
> - **Feature-commande** (la plupart) : une ou plusieurs commandes WebSocket
>   (`uptime.add`, `devices.list`, `logs.list`…) dispatchées par le serveur, avec
>   éventuellement une UI (widget de la grille d'accueil ou page de la topbar).
>   Les deux premières sont des commandes de module, la troisième une commande
>   transversale de l'app.
> - **Page structurelle** : un écran qui fait partie de DevEye lui-même (Profil,
>   Sécurité, Logs), atteint depuis le menu de la topbar, **sans** carte sur la
>   grille. Peut quand même s'appuyer sur des commandes WS.
>
> Une feature peut n'avoir **que** du back (commande sans UI) ou **que** du front
> (page qui réutilise des commandes existantes). Ne fais que les étapes utiles.

---

## A. Contrats partagés — `DevEye-Types/` (à faire en premier)

Tout passe par des schémas zod partagés. Le serveur **et** le client importent
`@deveye/types`. ⚠️ **Lis [DEVELOPMENT.md](#g-workflow-@deveye/types--node_modules)
(section G) : un changement de types doit être mirroré dans `node_modules`.**

1. **Domaine** — `src/domain/<feature>.ts` : schémas zod + types des entités
   (`xSchema`, `type X`, et l'interface `XRow` de la ligne SQL si table dédiée).
2. **Commandes** — `src/features/<feature>.ts` : un objet par commande
   `{ command: 'x.action' as const, input: zod, output: zod }`, puis
   `export const <feature>Commands = [...] as const;`.
3. **Registre** — `src/features/registry.ts` : importer et **spread** dans
   `featureCommands` (`...<feature>Commands`).
4. **Barrel** — `src/index.ts` : exporter le domaine et les commandes.
5. **Version** — bump `package.json` (`x.y.z` → `x.y.(z+1)`).
6. **CI** — `cd DevEye-Types && npm run ci`.

---

## B. Base de données — `DevEye/src/db/` (si la feature stocke des données)

1. **Migration** — `src/db/migrations/0NN_<nom>.sql` (numéro suivant, jamais
   réutilisé). DDL pure. **Politique projet : migration de schéma franche, pas de
   shim de rétro-compat** — on peut renommer/supprimer des colonnes. Les
   migrations tournent automatiquement au démarrage (`db/migrate.ts`), une seule
   fois (table `_migrations`, clé = nom de fichier). MySQL : un fichier = exécuté
   en une requête (multi-statements, sur une connexion réservée aux migrations).
   Tout `CREATE TABLE` écrit `COLLATE utf8mb4_general_ci` : sans le dire, la
   table hérite de la base, qui n'a pas la même collation partout.
   Après toute migration du socle, `npm run gen:db-schema` sur une base migrée
   régénère `src/db/schema.sql` (la référence lisible) et
   `src/db/schema.generated.ts` (le type `Tables`), tous deux committés : la CI
   les compare à la base que son smoke vient de migrer, et
   `src/db/schema.assertions.ts` y confronte les types de lignes des dépôts.

    ⚠️ **Ne jamais modifier un fichier de migration déjà commité** dès l'instant où
    il a pu tourner quelque part (prod, une autre machine de dev) : `_migrations`
    ne rejoue jamais un nom déjà vu, donc l'édition est un no-op silencieux là où
    le fichier est déjà passé — la base et le fichier divergent sans erreur ni
    avertissement. Un besoin de schéma supplémentaire sur une table existante
    est **toujours** une nouvelle migration numérotée, jamais une retouche de
    l'ancienne (même si ça semble anodin en dev, où `tsx watch` peut avoir déjà
    appliqué une version intermédiaire du fichier avant qu'elle ne soit stabilisée
    — ce qui masque le problème en local tout en le laissant intact en prod).

    Toute table neuve a un sort dans l'export des données d'un compte, dans la
    même livraison : `CORE_EXPORT_TABLES` pour une table de l'app, la
    déclaration `accountExport` pour celle d'un module
    ([ACCOUNT_EXPORT.md](./ACCOUNT_EXPORT.md)). Sans lui, le smoke de la CI
    refuse la migration.

2. **Repo** — `src/db/repos/<feature>.ts` : `export interface XRepo { … }` +
   `export function xRepo(pool: Queryable): XRepo`. Requêtes paramétrées
   uniquement (`?`). Le `content` sensible est **chiffré** (voir section E).
3. **Branchement** — `src/db/index.ts` : ajouter au type `Database` **et** à
   `createDatabase()`.

---

## C. Handlers serveur — `DevEye/src/features/`

> Chemin natif : seules les commandes transversales de l'app et le transport
> des agents y vivent encore. Une feature d'espace écrit ses handlers dans
> son module (`features/<id>/src/server/`, `defineSdkFeature`,
> `SdkFeatureContext`), voir [FEATURE_SDK.md](./FEATURE_SDK.md).

1. **Handlers** — `src/features/<feature>/index.ts` : un `defineFeature({ ...cmd,
handler })` par commande. Le handler reçoit un `FeatureContext` (`ctx.db`,
   `ctx.userId`, `ctx.secure`, `ctx.audit`, `ctx.ip`, `ctx.logger`…) et renvoie
   l'`output`. Lever `FeatureError(code, message)` pour une erreur typée. - **Autorisation** : vérifie l'appartenance au workspace
   (`assertWorkspaceMember`) et/ou le rôle (`user.role === 'admin'`) selon le cas. - **Déverrouillage** : si données chiffrées par mot de passe, garder le
   `assertSecureUnlocked` (lève `locked` → le client demande le mot de passe). - Exporter `export const <feature>Features: FeatureDefinition<string, any, any>[] = [...]`.
2. **Registre** — `src/features/registry.ts` : importer et **spread** dans
   `featureHandlers` (`...<feature>Features`).
3. **Audit** (recommandé) — sur les actions notables, appeler
   `ctx.audit({ action: 'x.create', description: '…', level?, metadata? })`.
   Fire-and-forget ; l'acteur, l'IP, la source `web` et la catégorie (préfixe de
   commande) sont pré-remplis par le dispatcher. Voir
   [logs-feature](./CREATING_A_FEATURE.md) / `Services/AuditLog.ts`.

> Le dispatcher WS (`src/ws/handler.ts`) valide input **et** output contre les
> schémas zod automatiquement — pas de validation manuelle à écrire.

---

## D. UI client — `DevEye/client/src/`

1. **Composant** — `src/Features/<Name>/index.tsx` (+ `style.module.css`).
   Props `FeatureProps` (`user`, `workspace`, …). Appels via
   `ws.send('x.action', input)` (typé, validé). Réutiliser les primitives :
   `Button`, `TextInput`, `SelectInput`, `OpenPopup`, et les **CSS vars du thème**
   (`var(--accent)`, `var(--space-md)`, `var(--text-primary)`… — jamais de
   couleurs en dur). UI en **français**.
    - Pattern déverrouillage : envelopper les appels chiffrés dans un helper qui
      intercepte l'erreur `locked` et relance après `ensureSecrecyUnlocked()`
      (`withSecrecy` du barrel `deveye-sdk-client`, porté par `stores/secrecy.ts`).
2. **Popups & dialogues** — toujours `Dialog` (statique) ou `Popup` +
   `OpenPopup`/`ClosePopup` (impératif, request→response). Jamais de modale
   maison. Comportements **unifiés, fournis par `Dialog`** — ne pas les
   réimplémenter par popup :
    - **Entrée → action principale** : passer `onSubmit={submit}` (le même handler
      que le bouton principal du footer). Ne **pas** remettre de `onKeyDown`
      « Enter » sur les champs. `textarea`, `select` et contenteditable gardent leur
      Entrée. Pour les confirmations destructives, `onSubmit` câble la confirmation.
    - **Autofocus** : à l'ouverture, `Dialog` focus le `[data-autofocus]`, sinon le
      1er champ texte. Ne **pas** remettre de `inputRef` + `focus()` manuel à
      l'ouverture (garder un ref seulement pour un re-focus _après erreur_).
      `autoFocus={false}` pour désactiver.
    - **Échap** : géré par la pile `useDismissLayer` (`Components/Dialog`). `Dialog`,
      `WidgetPopup` (panneau feature) et `SettingsPanel` y sont déjà inscrits → Échap
      ferme **la couche la plus haute d'abord** (popup avant feature). N'ajoute
      **jamais** de listener `window` `keydown`/Escape dans une feature.
    - **Bouton principal dans un enfant** : si le formulaire est rendu _dans_ un
      `Dialog` qu'il ne possède pas (ex. `ShortcutForm` dans `AddTileMarket`),
      enregistrer son action via `useDialogSubmit(submit)` au lieu de `onSubmit`.
    - **Cohérence d'ajout** : une popup/sous-formulaire d'ajout se ferme après un
      ajout réussi (appareils, raccourcis, features, formulaires — tous pareils).
3. **Enregistrement** — - widget de grille → ajouter à `FEATURE_CATALOG` dans
   **`src/Pages/Home/catalog.tsx`** (`{ id, title, icon, description, category,
links?, WidgetContent, FullComponent, cacheDurationMinutes, preload?,
holdSecrecy? }`). Cela suffit à le faire apparaître dans la grille, dans le
   **marché d'ajout** (`organize/AddTileMarket.tsx` : `category` décide du rayon,
   `description` du sous-titre de la carte) **et** dans la fiche « À propos »
   (`Pages/Home/about/` : `links` y dessine les liaisons vers les autres
   fonctionnalités, lues dans les deux sens) ; - page structurelle → ajouter à `STATIC_VIEWS` dans `src/Pages/Home/index.tsx`
   (avec `hasCard: false`) et passer un `onOpenX` au `TopNavbar`
   (gater par rôle si besoin : `user.role === 'admin' ? () => handleExpand('x') : undefined`).
4. **Navbar** (page structurelle) — `src/Components/TopNavbar/TopNavbar.tsx` :
   ajouter la prop `onOpenX?` et l'entrée de menu (rendue seulement si la prop est
   fournie → gating naturel).
5. **Icône** — réutiliser une classe de `src/Styles/icons.css` (`icon-…`).
6. **Fraîcheur des widgets résumé** — un widget de grille qui affiche une donnée
   dérivée (ex. un compteur via `CountWidget` / `useWorkspaceCount`) se rafraîchit
   seul à l'(ré)ouverture de la socket, mais **pas** après une mutation. Quand une
   action de la feature change cette donnée (ajout/suppression), appeler
   `invalidate('<clé>')` (`@/stores/invalidation`) **juste après l'appel WS
   réussi** ; tout widget lisant cette clé via `useResourceVersion` re-fetch
   aussitôt. La clé est par convention la commande de comptage (`audience.count`,
   `git.count`) et doit figurer dans `ResourceKey`. Invalider **à la source
   de la mutation**, pas au cycle de vie du popup. Exemple : `features/audience/src/client/SiteDialog.tsx`.
7. **Vocabulaire technique** : l'interface s'adresse à quelqu'un qui débute en
   informatique. Un terme de métier indispensable dans une phrase (« zero
   knowledge », « webhook ») s'écrit `<Term id='…'>` (barrel SDK) : il ouvre sa
   définition du glossaire, et la phrase reste courte. Un terme nouveau s'ajoute
   à `client/src/Components/Term/glossary.ts` (deux ou trois phrases justes,
   sans autre jargon) et à `GlossaryTermId` du portrait typé.

---

## E. Sécurité / chiffrement (enveloppe, deux étages)

Voir [SECURITY_MODEL.md](./SECURITY_MODEL.md). Règles clés :

- Les données de feature au repos passent **toujours** par `ctx.secure`
  (`encrypt`/`tryDecrypt`), **jamais** par `ctx.crypt` (`seal`/`open`, réservés
  aux secrets liés à l'auth, ex. 2FA).
- Stocker en clair seulement les métadonnées non sensibles nécessaires au
  serveur pour lister/trier/gater sans déchiffrer (`sort_order`, `folder_id`, `level`,
  `workspace_id`…).
- Le contenu sensible passe par l'étage gardé (`ctx.secure`) ; l'étage ouvert
  (`ctx.secure.open`) est un choix explicite, assumé comme lisible par un
  serveur vivant. Le serveur ne lit l'étage gardé que tant que l'utilisateur n'a
  pas activé le chiffrement par mot de passe.

---

## F. Validation finale

```bash
./ci.sh                       # lint + typecheck des 3 repos (racine)
# ou ciblé :
cd DevEye-Types && npm run ci
cd DevEye        && npm run ci          # lint + typecheck serveur
cd DevEye/client && npm run ci          # lint + typecheck + build
```

Test manuel : `cd DevEye && npm run dev` (serveur + Vite). Se connecter,
ouvrir la feature.

Pour la page Tests et débogage (`Docs/DEBUG.md`) : les écrans internes de la
feature se nomment par `useSubView('<segment statique>')`, ses mails se
déclarent dans `mailSamples`, et un parcours critique mérite un scénario
`e2e` qui ne laisse rien derrière lui.

---

## G. Workflow `@deveye/types` ↔ `node_modules`

`@deveye/types` est consommé comme **paquet npm installé** (`@deveye/types`,
npmjs public), **pas** un symlink. Le serveur (tsx) et le client (vite) lisent
le `src` du paquet installé, hoisté dans `DevEye/node_modules/@deveye/types/`.

Après avoir édité `DevEye-Types/src/` en dev local, pour que serveur/client le
voient **sans publier**, mirrorer les fichiers modifiés dans
`DevEye/node_modules/@deveye/types/src/` et bumper la version de ce `package.json`
aussi. Vérifier :

```bash
diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
```

⚠️ **Vite met en cache le pré-bundling** : après un changement de types, si le
client plante sur un export manquant, vider le cache :
`rm -rf DevEye/client/node_modules/.vite` puis relancer le dev server.

Release réelle : publier `@deveye/types@x.y.z` sur npmjs (release GitHub du repo
de types → workflow publish), puis réinstaller côté serveur/client.

---

## Récapitulatif des points d'enregistrement (à ne pas oublier)

| #   | Fichier                                                | Action                                                              |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | `DevEye-Types/src/domain/<f>.ts`                       | schémas + types entité                                              |
| 2   | `DevEye-Types/src/features/<f>.ts`                     | commandes + `<f>Commands`                                           |
| 3   | `DevEye-Types/src/features/registry.ts`                | spread `...<f>Commands`                                             |
| 4   | `DevEye-Types/src/index.ts`                            | exports                                                             |
| 5   | `DevEye-Types/package.json`                            | bump version + mirror node_modules                                  |
| 6   | `DevEye/src/db/migrations/0NN_*.sql`                   | migration (si table)                                                |
| 7   | `DevEye/src/db/repos/<f>.ts`                           | repo (si table)                                                     |
| 8   | `DevEye/src/db/index.ts`                               | `Database` + `createDatabase`                                       |
| 9   | `DevEye/src/features/<f>/index.ts`                     | handlers + `<f>Features`                                            |
| 10  | `DevEye/src/features/registry.ts`                      | spread `...<f>Features`                                             |
| 11  | `DevEye/client/src/Features/<F>/`                      | composant + styles                                                  |
| 12  | `DevEye/client/src/Pages/Home/index.tsx`               | `FEATURES` ou `PAGES`                                               |
| 13  | `DevEye/client/src/Components/TopNavbar/TopNavbar.tsx` | entrée menu (page structurelle)                                     |
| 14  | `DevEye/client/src/stores/invalidation.ts`             | clé `ResourceKey` + `invalidate()` aux mutations (si widget résumé) |

Selon ce que la feature fait, cinq chantiers transverses ont chacun leur doc
et leur checklist propre : toute configuration → `Docs/SETTINGS.md` (la
coquille unique et son bouton commun, obligatoires) ; des réglages d'espace
réutilisables que les éléments désignent → `Docs/SOURCES.md` ; des alertes →
`Docs/NOTIFICATIONS.md` §8 ; des éléments partageables entre espaces →
`Docs/SHARING.md` ; des tables ou des fichiers → `Docs/ACCOUNT_EXPORT.md`
(leur sort dans l'export des données d'un compte).
