# Créer une nouvelle fonctionnalité

**Une nouvelle feature se fait en module, sans exception.** Le développeur
tiers part du
[template](https://github.com/Gerem66/DevEye-Feature-Template) et de sa doc
anglaise ; le mainteneur lit [FEATURE_SDK.md](./FEATURE_SDK.md) pour ce que
l'app tient du contrat. Toutes les features de l'app sont des modules dans
`features/*` ; CloudSync et les autres modules privés s'installent par
`features.local.json`. Tout ce qui a un widget, une page de feature ou des
données d'espace est un module, et ce document ne le concerne pas.

Le chemin **natif** (`src/features/`, `defineFeature`, `FeatureContext`) ne
sert qu'à deux choses : les **commandes transversales de l'app**, celles qui ne
relèvent d'aucune feature d'espace et gardent un accès à tout le contexte, et
le **transport des agents** (`agent.*`, des relais du hub, voir
[Appareils](../features/devices/README.md)). Les familles natives sont celles
de `src/features/registry.ts` : `admin.*`, `agent.*`, `debug.*`, `domain.*`,
`feedback.*`, `home.*`, `links.*`, `live.here`, `logs.*`, `notify.*`,
`remote.*`, `secrecy.*`, `share.*`, `twofa.*`, `user.*`, `workspace.*`.

Ce document est la checklist d'une commande de plus dans l'une de ces familles,
et d'une **page structurelle** : un écran de DevEye lui-même, atteint depuis le
menu du compte, sans carte sur la grille (Profil, Sécurité, Journaux, Retours,
Utilisateurs, Maintenance, Tests et débogage). `client/src/Features/` ne
contient que ces pages-là ; une page peut n'être qu'un écran qui réutilise des
commandes existantes, et une commande peut n'avoir aucun écran. Ne faites que
les étapes utiles.

---

## A. Contrats partagés (`@deveye/types`, à faire en premier)

Tout passe par des schémas zod partagés : le serveur **et** le client importent
`@deveye/types`. Un changement de types doit être miroité dans `node_modules`
pour être vu sans publication (section G).

1. **Domaine** : `src/domain/<feature>.ts`, schémas zod et types des entités
   (`xSchema`, `type X`, et l'interface `XRow` de la ligne SQL si table dédiée).
2. **Commandes** : `src/features/<feature>.ts`, un objet par commande
   `{ command: 'x.action' as const, input: zod, output: zod }`, puis
   `export const <feature>Commands = [...] as const;`.
3. **Registre** : `src/features/registry.ts`, importer et **spread** dans
   `featureCommands` (`...<feature>Commands`).
4. **Barrel** : `src/index.ts`, exporter le domaine et les commandes.
5. **CI** : `npm run ci` dans le dépôt des types. Aucun bump de version sans
   demande explicite.

---

## B. Base de données (si la commande stocke des données)

1. **Migration** : `src/db/migrations/NNN_<nom>.sql` (numéro suivant, jamais
   réutilisé). DDL pure, migration de schéma franche, pas de shim de
   rétro-compatibilité : on peut renommer et supprimer des colonnes. Les
   migrations tournent au démarrage (`src/db/migrate.ts`), une seule fois
   (table `_migrations`, clé = nom de fichier), un fichier = une requête
   multi-instructions sur une connexion réservée. Tout `CREATE TABLE` écrit
   `COLLATE utf8mb4_general_ci` : sans le dire, la table hérite de la base,
   qui n'a pas la même collation partout. Jamais de point-virgule dans un
   commentaire SQL : le moteur découpe dessus. Après toute migration du socle,
   `npm run gen:db-schema` sur une base migrée régénère `src/db/schema.sql`
   (la référence lisible) et `src/db/schema.generated.ts` (le type `Tables`),
   tous deux committés : la CI les compare à la base que son smoke vient de
   migrer, et `src/db/schema.assertions.ts` y confronte les types de lignes des
   dépôts.

    **Ne jamais modifier un fichier de migration déjà commité** dès l'instant
    où il a pu tourner quelque part : `_migrations` ne rejoue jamais un nom
    déjà vu, donc l'édition est un no-op silencieux là où le fichier est déjà
    passé, et la base et le fichier divergent sans erreur. Un besoin de schéma
    supplémentaire sur une table existante est **toujours** une nouvelle
    migration numérotée, même quand `tsx watch` a déjà appliqué en local une
    version intermédiaire du fichier : ce qui masque le problème en local le
    laisse intact ailleurs.

    Toute table neuve a un sort dans l'export des données d'un compte, dans la
    même livraison : `CORE_EXPORT_TABLES` (`src/Services/accountExport/coverage.ts`)
    pour une table de l'app, la déclaration `accountExport` pour celle d'un
    module ([ACCOUNT_EXPORT.md](./ACCOUNT_EXPORT.md)). Sans lui, le boot et le
    smoke de la CI refusent la migration.

2. **Repo** : `src/db/repos/<feature>.ts`, `export interface XRepo { … }` +
   `export function xRepo(pool: Queryable): XRepo`. Requêtes paramétrées
   uniquement (`?`). Le contenu sensible est **chiffré** (section E).
3. **Branchement** : `src/db/index.ts`, ajouter au type `Database` **et** à
   `createDatabase()`.

---

## C. Handlers serveur (`src/features/`)

1. **Handlers** : `src/features/<feature>/index.ts`, un
   `defineFeature({ ...cmd, access, mutates?, handler })` par commande. Le
   handler reçoit un `FeatureContext` (`ctx.db`, `ctx.userId`,
   `ctx.workspaceId`, `ctx.workspace`, `ctx.secure`, `ctx.crypt`, `ctx.audit`,
   `ctx.ip`, `ctx.logger`, `ctx.isAdmin`…) et renvoie l'`output`. Une erreur
   typée se lève par `FeatureError(code, message)`.
    - **Autorisation** : déclarer `access` (`feature` et `level`, `extras`,
      `capabilities`, `admin: true`, `scope: 'account'`) ; le dispatcheur
      l'applique avant le handler, comme la validation zod. Une commande dont
      la cible est un argument (`notify.route*`, `share.*`, `domain.*`) vérifie
      en tête de handler et figure dans `ACCESS_EXEMPT`
      (`src/features/_permissions.ts`) : `assertAccessDeclared` refuse sinon le
      démarrage. Voir [PERMISSIONS.md](./PERMISSIONS.md).
    - **Sujet en direct** : une commande qui modifie des données déclare
      `mutates`, et son préfixe doit figurer dans `COMMAND_PREFIX_TOPIC`
      (`src/features/_topics.ts`) ; `buildTopicIndex` refuse au boot un préfixe
      inconnu ou un sujet qui n'existe pas. Voir [LIVE.md](./LIVE.md).
    - Exporter `export const <feature>Features: FeatureDefinition<string, any, any>[] = [...]`.
2. **Registre** : `src/features/registry.ts`, importer et **spread** dans
   `featureHandlers` (`...<feature>Features`). Une commande déclarée deux fois
   (module et native) fait échouer le chargement.
3. **Audit** (recommandé) : sur les actions notables, appeler
   `ctx.audit({ action: 'x.create', description: '…', level?, metadata? })`.
   Fire-and-forget ; l'acteur, l'IP, la source `web` et la catégorie (préfixe
   de commande) sont pré-remplis par le dispatcheur. Voir
   `src/Services/AuditLog.ts` et [LOGS.md](./LOGS.md).

Le dispatcheur WS (`src/ws/handler.ts`) valide input **et** output contre les
schémas zod : pas de validation manuelle à écrire.

---

## D. UI client (`client/src/`)

1. **Page structurelle** : `src/Features/<Name>/index.tsx` (+
   `style.module.css`), puis une entrée dans `buildStaticViews()`
   (`src/Pages/Home/index.tsx`, `hasCard: false`). Une page réservée aux
   administrateurs s'ajoute à `ADMIN_VIEW_IDS` dans le même fichier : c'est la
   liste des pages système du menu du compte, que `TopNavbar` reçoit en
   `adminPages` et ne rend qu'à un administrateur. Appels via
   `ws.send('x.action', input)` (typé, validé). Réutiliser les primitives
   (`Button`, `TextInput`, `SearchSelect`, `LoadingVeil`, `LogOutput`,
   `OpenPopup`) et les **jetons CSS du thème** (`var(--accent)`,
   `var(--space-md)`, `var(--text-primary)`…, jamais de couleur en dur).
   Interface en **français**, qui vouvoie.
    - L'en-tête d'une vue (retour, titre, gestes, et la barre d'onglets qui
      le suit) s'enveloppe dans `StickyHeader`, premier enfant de la racine :
      il reste en haut de la popup pendant qu'on fait défiler le contenu. La
      racine ne défile jamais elle-même (`min-height: 100%`, pas
      d'`overflow`) ; un bandeau collant du contenu se pose dessous par
      `top: var(--sticky-head, 0px)`.
    - Chiffrement par mot de passe : envelopper les appels qui peuvent répondre
      `locked` dans `withSecrecy` (`client/src/stores/secrecy.ts`, exporté par
      le barrel `deveye-sdk-client`), qui relance une fois après l'invite.
2. **Popups et dialogues** : toujours `Dialog` (statique) ou `Popup` +
   `OpenPopup`/`ClosePopup` (impératif, requête puis réponse). Jamais de modale
   maison. Les comportements communs sont **fournis par `Dialog`**
   (`client/src/Components/Dialog`), à ne pas réimplémenter :
    - **Entrée vaut action principale** : passer `onSubmit={submit}` (le même
      handler que le bouton principal du pied). Pas de `onKeyDown` « Enter »
      sur les champs ; `textarea`, `select` et contenteditable gardent leur
      Entrée. Pour une confirmation destructive, `onSubmit` câble la
      confirmation.
    - **Autofocus** : à l'ouverture, `Dialog` focalise le `[data-autofocus]`,
      sinon le premier champ texte. Pas de `inputRef` + `focus()` manuel à
      l'ouverture (un ref ne sert qu'à un re-focus après erreur).
      `autoFocus={false}` pour désactiver.
    - **Échap** : géré par la pile `useDismissLayer`. `Dialog`, `WidgetPopup`
      (panneau de feature) et `SettingsPanel` y sont inscrits : Échap ferme la
      couche la plus haute d'abord. Jamais de listener `window`
      `keydown`/Escape dans une page.
    - **Bouton principal dans un enfant** : un formulaire rendu dans un
      `Dialog` qu'il ne possède pas enregistre son action par
      `useDialogSubmit(submit)` au lieu de `onSubmit`.
    - **Cohérence d'ajout** : une popup ou un sous-formulaire d'ajout se ferme
      après un ajout réussi, partout pareil.
3. **Icône** : réutiliser une classe de `src/Styles/icons.css` (`icon-…`).
4. **Fraîcheur des widgets résumé** : un widget qui affiche une donnée dérivée
   (un compteur via `CountWidget` / `useWorkspaceCount`) se rafraîchit seul à
   l'ouverture de la socket, mais **pas** après une mutation. Quand une action
   change cette donnée, appeler `invalidate('<clé>')` (`client/src/stores/invalidation.ts`
   côté app, `invalidate` du barrel `deveye-sdk-client` côté module) **juste
   après l'appel WS réussi** ; tout widget lisant cette clé via
   `useResourceVersion` relit aussitôt. La clé est par convention la commande
   de comptage et figure dans `ResourceKey` (un module la déclare dans
   `manifest.resources`). Invalider **à la source de la mutation**, pas au
   cycle de vie du popup.
5. **Vocabulaire** : l'interface s'adresse à quelqu'un qui débute en
   informatique. Un terme de métier indispensable dans une phrase
   (« webhook ») s'écrit `<Term id='…'>` (`client/src/Components/Term`,
   exporté par le barrel) : il ouvre sa définition du glossaire, et la phrase
   reste courte. Un terme nouveau s'ajoute à
   `client/src/Components/Term/glossary.ts` (deux ou trois phrases justes, sans
   autre jargon) et à `GlossaryTermId` du portrait typé du barrel.
6. **Mesure** : un écran interne se nomme par `useSubView('<segment>')`
   (`client/src/telemetry/useView.ts`) pour la page Tests et débogage
   ([DEBUG.md](./DEBUG.md)).

---

## E. Chiffrement (enveloppe, deux étages)

Voir [SECURITY_MODEL.md](./SECURITY_MODEL.md). Dans un handler natif :

- la donnée au repos passe par `ctx.secure` (`src/Services/SecureStore.ts`, un
  `Cipher` : `encrypt`, `decrypt`, `tryDecrypt`), l'étage gardé, illisible par
  le serveur quand l'utilisateur a activé le chiffrement par mot de passe et que
  sa session est scellée ; `ctx.secure.open` est l'étage ouvert, un choix
  explicite, assumé comme lisible par un serveur vivant ;
- `ctx.crypt` (`src/Services/Encryption.ts` : `sealFor`, `openFor`,
  `openTextFor`) scelle sous la clé serveur et ne sert qu'aux secrets de
  l'authentification (2FA), jamais à la donnée d'une feature ;
- en clair, seulement les métadonnées dont le serveur a besoin pour lister,
  trier ou garder sans déchiffrer (`sort_order`, `folder_id`, `workspace_id`…).

Côté module, la même règle s'écrit `ctx.cipher()` (étage ouvert) et
`ctx.cipher('private')` (étage gardé) : voir le guide
`04-storage-and-encryption` du template.

---

## F. Validation

```bash
cd DevEye-Types && npm run ci          # types
cd DevEye        && npm run ci          # lint, format, typecheck, tests, glue
cd DevEye        && npm run ci:features # modules in-repo
cd DevEye        && npm run ci:smoke    # smoke E2E de chaque module (il lui faut la base)
cd DevEye        && npm run check:queries # chaque requête préparée sur la base migrée
cd DevEye/client && npm run ci          # lint, typecheck, check:sdk, tests, build
```

`check:queries` prépare chaque `query`/`execute` du module sur la base des
variables `DB_*` (rien ne s'exécute) : une colonne inconnue, un `?` sans
paramètre ou un champ de `query<T>` que la requête ne rend pas, ou pas du type
déclaré (un NULL possible, un ENUM plus large), y échouent avec `fichier:ligne`.
Il couvre aussi les modules privés installés par `features.local.json`. Un SQL
assemblé à l'exécution n'est pas vérifié (`--verbose` le liste) ; un appel
qu'il ne sait pas préparer s'écarte par `// check-queries: ignore <raison>`.

Jamais `npx eslint .` à la racine de `DevEye/` : `npm run lint`,
`npm run lint:features`, et dans `client/` `npm run lint`. Prettier couvre
aussi `.md`, `.yml`, `.css`, `.html` et `.json` (`format:check`).

Test manuel : `npm run dev` (serveur + Vite), se connecter, ouvrir l'écran.

---

## G. Workflow `@deveye/types` ↔ `node_modules`

`@deveye/types` est consommé comme **paquet npm installé** (npmjs public),
**pas** un lien symbolique. Le serveur (tsx) et le client (vite) lisent le
`src` du paquet installé, hoisté dans `node_modules/@deveye/types/`.

Après avoir édité le `src/` du dépôt des types, pour que le serveur et le
client le voient **sans publier**, miroiter la source dans chaque dépôt qui
installe le paquet depuis npm. Depuis le dossier qui tient les dépôts côte à
côte :

```bash
for t in DevEye DevEye-Feature-Template DevEye-CloudSync; do
    rsync -a --delete DevEye-Types/src/ $t/node_modules/@deveye/types/src/
done
diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
```

Les modules privés qui installent le paquet en `file:../DevEye-Types` ont un
lien symbolique vers la source : rien à miroiter chez eux.

Vite met en cache le pré-bundling : après un changement de types, si le client
plante sur un export manquant, vider le cache
(`rm -rf client/node_modules/.vite`) puis relancer le serveur de dev.

Publication réelle : `@deveye/types@x.y.z` sur npmjs (release GitHub du dépôt
des types, workflow publish), puis réinstaller côté serveur et client.

---

## Récapitulatif des points d'enregistrement

| #   | Fichier                                                       | Action                                          |
| --- | ------------------------------------------------------------- | ----------------------------------------------- |
| 1   | types : `src/domain/<f>.ts`                                   | schémas + types d'entité                        |
| 2   | types : `src/features/<f>.ts`                                 | commandes + `<f>Commands`                       |
| 3   | types : `src/features/registry.ts`, `src/index.ts`            | spread `...<f>Commands`, exports                |
| 4   | `src/db/migrations/NNN_*.sql`                                 | migration, sort dans l'export (si table)        |
| 5   | `src/db/repos/<f>.ts`, `src/db/index.ts`                      | repo, `Database` + `createDatabase` (si table)  |
| 6   | `src/features/<f>/index.ts`, `src/features/registry.ts`       | handlers avec `access`, spread `...<f>Features` |
| 7   | `client/src/Features/<F>/`, `client/src/Pages/Home/index.tsx` | page, `buildStaticViews`, `ADMIN_VIEW_IDS`      |

Selon ce que la commande touche, les systèmes transverses ont chacun leur doc :
toute configuration → [SETTINGS.md](./SETTINGS.md) (la coquille unique et son
bouton commun) ; des réglages d'espace réutilisables que les éléments
désignent → [SOURCES.md](./SOURCES.md) ; des alertes →
[NOTIFICATIONS.md](./NOTIFICATIONS.md) ; des éléments partageables entre
espaces → [SHARING.md](./SHARING.md) ; des tables ou des fichiers →
[ACCOUNT_EXPORT.md](./ACCOUNT_EXPORT.md).
