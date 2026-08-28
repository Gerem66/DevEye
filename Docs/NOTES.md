# Notes, les pense-bêtes de l'espace

> Écrit le 28 août 2026, le jour où les Notes sont devenues le premier module
> à **palier par élément** branché sur le partage inter-espaces
> (`features/notes`, [FEATURE_SDK.md](./FEATURE_SDK.md)). Il dit *pourquoi* ;
> le code dit comment.
>
> Documents voisins : [SECURITY_MODEL.md](./SECURITY_MODEL.md) (les deux
> étages, section « Notes privées »), [SHARING.md](./SHARING.md) (le
> mécanisme de projection), [PERMISSIONS.md](./PERMISSIONS.md) (les
> restrictions par élément), [SETTINGS.md](./SETTINGS.md) (la coquille de
> réglages), [LIVE.md](./LIVE.md).

Des notes à blocs (paragraphes, cases à cocher, listes, titres, filets)
rangées dans des dossiers, par espace ; une archive à deux temps ; et, pour
l'espace personnel, des notes **privées** chiffrées par le mot de passe de
leur auteur.

---

## 1. Le module

Notes est un module in-repo depuis son rapatriement sur le SDK (la cinquième
native migrée) :

- `src/contracts/{domain,commands}.ts` : les schémas zod (blocs, note,
  résumé, dossier) et les quatorze commandes sous le seul préfixe `notes.` ;
- `src/server/repo.ts` (les deux tables, `notes` et `note_folders`, derrière
  un seul dépôt), `handlers.ts`, `_shared.ts` (le choix du codec, les gardes,
  les DTO), `index.ts` (l'entrée : le dépôt, les handlers, l'entrée `items`
  du partage) ;
- `src/client/` : la vue (`Notes.tsx`), la grille et les cartes, l'éditeur à
  blocs, l'archive, la carte d'accueil (`NotesWidget.tsx`) ;
- `deveye-feature.json` : l'allowlist des deux tables historiques (socle 014
  et 015, rattachées à l'espace par la 048), jamais déplacées.

Pas de service de fond, pas d'onglet de réglages propre : ce qu'une note
règle (où elle est visible, ce qu'en voit chaque rôle) vient de la coquille
commune, montée dans son éditeur.

## 2. Les deux étages, choisis par note

Le corps d'une note (titre et blocs) est un blob chiffré ; `folder_id`,
`sort_order`, `is_private`, `archived_at` et les dates restent des colonnes
claires, pour lister, grouper et classer sans rien déchiffrer.

- une note **ordinaire** vit à l'étage **ouvert** : la clé de l'espace, que le
  serveur sait relire seul. La feature s'ouvre sans invite ;
- une note **privée** (`is_private = 1`) a son corps à l'étage **gardé** : la
  DEK emballée par le mot de passe. Il n'y a aucun contrôle d'accès par-dessus,
  c'est le chiffrement qui protège ; session scellée, la liste la rend
  **masquée** (métadonnées claires, ni titre ni aperçu) et ses écritures
  répondent `locked`.

Le drapeau n'existe que dans l'**espace personnel** : dans un espace partagé,
les deux étages utilisent la clé de l'espace, et une note « privée » y serait
lisible par tous. Le serveur refuse (`validation`), l'éditeur ne propose pas le
bouton. Le détail dans [SECURITY_MODEL.md](./SECURITY_MODEL.md).

## 3. Le partage inter-espaces

Le registre dit `shareTier: 'perItem'` et le module tient l'engagement
([SHARING.md](./SHARING.md) §2) : l'entrée `items` de son serveur (domicile,
intitulé, `shareable`), `ctx.sharing.scope()` dans ses listages, et
`ctx.items.restrictions()` / `ctx.items.assert()` sur ce qu'ils rendent.

### Ce qui se projette

Une note **ordinaire**, vers un espace dont l'appelant est membre. Elle garde
son **domicile** : la ligne reste dans l'espace d'origine, chiffrée sous sa
clé ouverte, et la fenêtre la lit avec le codec de cet espace-là, choisi
**ligne à ligne** dans `notes.list` et `notes.get` (`bodyCipher`). Rien n'est
re-chiffré.

Depuis la fenêtre, la note se lit, s'**édite**, s'**archive** et se
**restaure** : chaque écriture vise la ligne chez elle
(`existing.workspace_id`), sous son codec (`scope.cipherFor`). Le client la
signale par la pastille « partagée » (`foreign: true` sur le DTO), la même
qu'Uptime.

Elle n'a **ni dossier ni rang ici** : le DTO porte `folderId: null`, elle se
range à la racine, après les notes locales, et son dossier chez elle n'est pas
touché par une édition depuis la fenêtre (le handler conserve
`existing.folder_id`). Une note projetée n'a pas d'ordre propre à chaque
espace : cela demanderait une colonne par projection, ce qu'un réglage
d'affichage ne vaut pas.

### Ce qui reste au domicile

| Depuis la fenêtre | Domicile seulement |
|---|---|
| lire, éditer le corps, archiver, restaurer | **classer** (dossier, rang) |
| | **passer en privé** |
| | **détruire** |

Le critère est celui de SHARING.md : un geste reste au domicile quand il
référence d'autres objets de l'espace d'origine ou en changerait la clé.

- **classer** : un dossier d'ici n'existe pas chez elle. `notes.edit` avec un
  `folderId` non nul et `notes.reorder` avec son identifiant répondent
  `validation` ; le client ne propose ni le menu « Déplacer vers » ni le
  glisser sur une note projetée, et l'exclut de l'ordre qu'il envoie ;
- **passer en privé** : elle serait chiffrée par le mot de passe d'un membre
  d'ici, donc illisible chez elle et dans toutes ses autres fenêtres.
  `validation`, et le bouton n'est pas affiché ;
- **détruire** : `notes.delete` répond `forbidden` depuis une fenêtre, avec la
  marche à suivre (retirer la projection depuis l'onglet Partage, ou supprimer
  depuis l'espace d'origine). L'archive n'offre pas le geste sur une note
  projetée. Chez elle, la suppression appelle `ctx.items.forget` : projections
  et restrictions partent avec la ligne.

### Une note privée n'est jamais projetable

C'est une impossibilité mécanique, pas une prudence : son corps est chiffré
par le mot de passe de son auteur, qu'aucun autre espace ne détient.
L'invariant est tenu aux deux portes :

- **à l'entrée**, `items.shareable` répond `false` pour `is_private = 1` et
  `share.set` refuse en le disant. Côté client, l'éditeur monte le bouton
  commun avec `shareable: !note.private` : l'onglet Partage n'est pas proposé
  sur une note privée, plutôt qu'ouvert sur un refus. Les permissions par
  élément, elles, restent réglables ;
- **à la bascule**, quand une note ordinaire déjà projetée **devient privée**
  chez elle (`notes.edit` avec `private: true` sur une note qui ne l'était
  pas), le handler appelle `ctx.items.forget` : ses projections partent, et
  ses restrictions par élément avec. C'est exactement juste : une note privée
  n'existe que dans un espace personnel, où aucune restriction de rôle n'a de
  sens. Ses fenêtres la perdent aussitôt (le hub rejoue le sujet `notes` dans
  les espaces reliés) ; si elle redevient ordinaire, elle repart de zéro,
  sans projection à rallumer.

`listVisible` et `findVisible` n'ont donc rien à filtrer : une projection ne
vise jamais une note privée.

### Les restrictions par élément

Depuis que les Notes sont branchées, la coquille propose l'onglet Permissions
sur une note d'un espace partagé, et les listages font respecter ce qu'il
règle : une note masquée pour ce rôle (`none`) **disparaît** de `notes.list`
et de `notes.count` plutôt que d'y figurer grisée ; en lecture seule
(`read`), elle se lit mais `notes.edit`, `notes.archive`, `notes.restore` et
`notes.delete` répondent `forbidden` (`ctx.items.assert(id, 'write')`), et le
classement l'ignore comme un identifiant étranger.

### Les compteurs et la diffusion

`notes.count` compte les **mêmes lignes** que la liste : les actives visibles,
projetées comprises, restrictions déduites, sur les métadonnées claires (aucune
DEK, aucun verrou, les privées comme les autres). Une carte qui compte autre
chose que la liste qu'elle ouvre se lit comme un bug.

Le sujet `notes`, battu après chaque écriture, est rejoué par le hub dans les
espaces reliés par une projection ([SHARING.md](./SHARING.md) §8) : une note
éditée depuis sa fenêtre rafraîchit son domicile, et inversement.

## 4. Les tests

`src/server/handlers.test.ts`, sur le harnais du SDK (`@deveye/types/sdk/testing`)
et un dépôt en mémoire qui reproduit `item_shares` (`projections`) : le masque
et le verrou, la règle des espaces, l'archive à deux temps, le rangement des
dossiers, les restrictions par élément, le partage (listage d'une projection,
écriture chez elle, refus depuis la fenêtre, oubli des projections d'une note
qui devient privée) et l'entrée `items` (`homeOf`, `labelOf`, `shareable`).
