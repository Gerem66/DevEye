# Features modulaires — la cible d'architecture

> Écrit le 20 août 2026. Document de **direction** : il décrit où l'on va, ce
> qui existe déjà, et le chemin. Rien ici n'est un engagement de calendrier.
>
> Documents voisins : [CREATING_A_FEATURE.md](./CREATING_A_FEATURE.md) (l'état
> actuel, et la mesure de la friction), [PERMISSIONS.md](./PERMISSIONS.md),
> [SHARING.md](./SHARING.md), [NOTIFICATIONS.md](./NOTIFICATIONS.md).

---

## 1. La cible

**Une fonctionnalité = un dossier.** Potentiellement un dépôt git à part
entière, qui n'a besoin que de `deveye-types` pour s'intégrer complètement à
DevEye :

```
ma-feature/
├── manifest.ts          # le descripteur : id, libellé, icône, ce qu'elle sait faire
├── contracts/           # schémas zod : domaine + commandes (aujourd'hui dans DevEye-Types)
├── server/
│   ├── migrations/      # SES tables, SES migrations, préfixées par son id
│   ├── repo.ts          # ses requêtes
│   └── handlers.ts      # ses defineFeature()
└── client/
    ├── Widget.tsx       # la carte de l'accueil
    ├── index.tsx        # la vue complète
    └── style.module.css
```

Les features actuelles restent dans le dépôt principal comme **features
natives** — même contrat, juste co-hébergées. Une feature externe s'ajoute en
déposant son dossier ; à terme, le marché d'ajout de l'accueil gagne une
catégorie « Nouvelle feature » avec les instructions et l'import.

## 2. Ce que le contrat doit couvrir — et ce qui existe déjà

La colonne de droite est l'état réel au 20/08/2026 :

| Besoin | Contrat visé | Aujourd'hui |
|---|---|---|
| Descripteur (id, libellé, icône, capacités) | `manifest.ts` | ✅ `FEATURE_REGISTRY` (`deveye-types/domain/featureRegistry.ts`) — le descriptif dit une fois |
| Commandes typées | schémas zod input/output | ✅ `defineFeature()` + dispatcheur WS qui valide, autorise, diffuse |
| Stockage | migrations embarquées | ⚠️ migrations **globales** numérotées (`0NN_*.sql`) — pas de namespace par feature |
| Widget d'accueil | une entrée de manifeste | ⚠️ `FEATURE_CATALOG` (client) à éditer à la main |
| Permissions | rien à écrire | ✅ acquis par construction : `access` déclaratif + contrôle de boot ; le rôle accorde `read`/`write` ; restrictions par élément via `SHARE_WIRED` |
| Espaces / partage | `shareTier` du manifeste | ✅ le registre le porte ; le branchement (`listVisible` + codec) reste par feature |
| Live (présence, curseurs, surbrillance) | une API de segments | ✅ `useLiveSegment(niveau, valeur)` + `useLiveOutlines` — déjà générique |
| Notifications | `notifies: true` au manifeste | ✅ canaux + routes génériques (`notify.*`), la coquille de réglages rend l'onglet toute seule |
| Chiffrement serveur (défaut) | `ctx.secure.open` | ✅ unifié |
| Chiffrement par mot de passe | `ctx.secure` + invite unifiée | ✅ `assertSecureUnlocked` côté serveur, `withSecrecy`/`holdSecrecy` côté client |
| Réglages | rien à écrire | ✅ `FeatureSettingsButton` : les sections viennent du manifeste et des droits |

Le contrat n'est donc pas à inventer : **il existe, dispersé**. Le chantier est
de le rassembler derrière un point d'entrée unique par feature, puis de faire
découvrir ces points d'entrée au lieu de les recenser à la main.

## 3. La friction actuelle, mesurée

`CREATING_A_FEATURE.md` recense **14 points d'enregistrement** répartis sur
trois bases de code pour ajouter une feature. Chacun est individuellement
justifié ; leur somme est le problème. Les pires :

- `features/registry.ts` (serveur) + `features/registry.ts` (types) +
  `Pages/Home/catalog.tsx` (client) — trois spreads à la main ;
- `_topics.ts` — la table préfixe → sujet, qui fait échouer le boot si on
  l'oublie (bien), mais qu'on doit connaître (moins bien) ;
- `stores/invalidation.ts` — les clés de fraîcheur ;
- `db/index.ts` — le branchement du repo ;
- le mirroring `deveye-types` ↔ `node_modules`.

## 4. Le chemin, par étapes qui rapportent chacune seule

1. **Le manifeste absorbe le catalogue client.** `FEATURE_CATALOG` lit le
   registre (libellé, icône, description, catégorie) et n'ajoute que ce qui est
   du code (les composants). Déjà amorcé — la fiche « À propos » et le marché
   lisent le registre.
2. **Un point d'entrée serveur par feature.** `src/features/<f>/index.ts`
   exporte un objet unique `{ handlers, topics, repos, migrationsDir }` ;
   `registry.ts`, `_topics.ts` et `db/index.ts` se construisent en itérant ces
   objets au lieu d'être édités.
3. **Migrations par feature.** Un préfixe d'identifiant (`uptime/001_…`) et une
   table `_migrations` qui porte le couple (feature, nom). Les migrations
   globales restent pour le socle (users, workspaces).
4. **Découverte.** Le serveur parcourt `src/features/*/` — natif ou déposé — et
   charge ce qui expose le point d'entrée. À ce stade, « installer une feature »
   = poser un dossier et redémarrer.
5. **Le marché.** La catégorie « Nouvelle feature » dans l'ajout de tuiles :
   les instructions, le lien vers ce document, et l'état des features déposées.

## 5. L'import par l'interface — à traiter les yeux ouverts

« Importer un dossier depuis l'interface » veut dire **téléverser du code qui
s'exécutera côté serveur avec tous les droits du serveur** — la base entière,
les clés d'API, les archives de sauvegarde. C'est l'écart entre installer un
plugin et se faire installer une porte dérobée, et aucune validation de schéma
ne l'annule : le manifeste peut être honnête et `handlers.ts` malveillant.

La forme défendable : l'import **dépose et déclare**, l'activation reste un
geste d'administrateur au déploiement (le dossier arrive par git, l'interface
montre ce qui est déposé et l'état de son chargement). Un vrai bac à sable
(processus séparé, capacités restreintes) est le prix d'entrée d'un import
« chaud » — c'est un chantier en soi, à ne pas sous-estimer.

## 6. Ce que ça change pour DevEye-Types

Le paquet devient la **surface d'API publique** du produit : tout ce qu'une
feature externe peut toucher doit y être exporté et versionné ; tout ce qui n'y
est pas est interne et peut bouger. C'est déjà presque vrai — le manifeste, les
contrats de commandes, les schémas de partage et de notifications y vivent. Le
travail restant est de la discipline, pas de l'architecture.
