# Les permissions — qui a le droit de quoi

> Réécrit le 20 août 2026, après le retour d'usage sur le chantier des droits.
> Il dit **pourquoi** ; le code dit comment.
>
> Documents voisins : [../../WORKSPACES.md](../../WORKSPACES.md) §3,
> [SHARING.md](./SHARING.md) pour les restrictions par élément,
> [NOTIFICATIONS.md](./NOTIFICATIONS.md).

---

## 1. Les quatre étages

| # | Étage | Où | Ce qu'il tranche |
|---|---|---|---|
| 1 | Compte DevEye | `users.role` | administrateur ou utilisateur : la flotte et les pages système |
| 2 | Appartenance à l'espace | `workspace_members` | la frontière absolue — même un admin n'entre pas chez autrui |
| 3 | Rôle : capacités + features | `workspace_roles.capabilities` / `.features` | gouverner l'espace ; ouvrir une fonctionnalité en lecture ou en écriture |
| 4 | Restrictions par élément | `item_role_grants` | ce qu'un rôle voit de **cette** ligne-là : masquée, ou en lecture seule |

Les étages 3 et 4 sont **hiérarchiques** : une restriction d'élément abaisse ce
que le rôle accorde, elle n'ouvre jamais ce qu'il ferme. L'absence de ligne au
niveau 4 vaut « rien de particulier » — seules les exceptions existent en base.

## 2. Une décision actée : pas d'étage intermédiaire

Un étage a existé entre les deux derniers : des **droits fins par
fonctionnalité** (`deploy.trigger`, `database.execute`, une vingtaine de clés),
avec leur matrice rôles × droits sous un onglet Permissions, et une capacité
`workspace.permissions` distincte de `workspace.roles`.

Retiré sur retour d'usage, et la raison mérite d'être gardée : **la granularité
utile est celle des espaces et celle des éléments, pas celle des gestes.** Pour
donner moins qu'`écriture` sur une fonctionnalité, on donne `lecture` ; pour
faire un sous-groupe, on restreint **des éléments** (« ce rôle ne voit pas cette
base ») — pas des verbes (« ce rôle ne peut pas exporter »). L'étage
intermédiaire ajoutait une matrice à relire, une capacité à comprendre, une
règle d'intersection à maintenir aux deux bouts, pour un pouvoir d'expression
que personne n'exerçait.

Trois choses de ce chantier ont survécu, parce qu'elles étaient justes
indépendamment de l'étage :

- **le contrôle de démarrage** (§4) — c'est lui qui a révélé 76 commandes sans
  garde ;
- **le registre des fonctionnalités** (`FEATURE_REGISTRY`) — le descriptif dit
  une fois, au lieu de trois copies qui divergent ;
- **les restrictions par élément** (§5) — le vrai quatrième étage.

## 3. Le rôle s'édite entier, dans sa popup

Un détour a existé : l'identité du rôle dans sa popup, ses droits dans une
matrice globale. Retiré aussi — l'usage réel est « configurer CE rôle », et
couper un rôle en deux écrans obligeait à savoir lequel des deux détenait quoi.

`RoleDialog` porte donc tout : nom, couleur, capacités, accès par
fonctionnalité. Les intitulés viennent du registre, jamais d'une table locale.
Une seule capacité gouverne les rôles, `workspace.roles` — existence **et**
contenu : le découpage plus fin produisait des demi-refus illisibles sur un même
formulaire.

## 4. Une déclaration, pas une garde écrite à la main

```ts
export interface FeatureAccessSpec {
    feature?: WorkspaceFeatureId;
    level?: FeatureAccess;              // défaut 'read'
    capabilities?: WorkspaceCapability[];
    admin?: true;
    scope?: 'account';
}
```

Appliqué par le dispatcheur **avant** le handler, comme la validation zod.

### La faille que le contrôle de démarrage a fermée

Au début du chantier, quatre modules — `uptime` (12 commandes), `mail` (26),
`weather` (8), `cloudSync` (30) — ne déclaraient **aucun** `access`. Les quatre
sont pourtant accordables dans l'écran des rôles : un membre dont le rôle ne les
accordait pas voyait l'interface masquée et **pouvait appeler chacune des 76
commandes**. La diffusion, elle, filtrait bien (`TOPIC_FEATURE`), ce qui rendait
la chose invisible.

D'où `assertAccessDeclared()` (`features/_permissions.ts`), appelé au boot : le
serveur **refuse de démarrer** si une commande n'est gardée par rien et ne
figure pas dans `ACCESS_EXEMPT`. Les exemptions ont trois raisons, documentées
sur place : le cycle de vie de l'espace (garde sur la ligne, `isOwner`), ce que
tout membre doit lire (`workspace.roleList`), et ce dont la cible est un
argument (`notify.route*`, `share.*` — vérifié en tête de handler).

## 5. Les restrictions par élément

Le quatrième étage, décrit en détail dans [SHARING.md](./SHARING.md) §6. Ce
qu'il faut en retenir ici :

- **restrictif seulement** — `none` masque, `read` passe en lecture seule ;
  rien n'élève. L'écran des rôles reste la seule réponse à « qui a accès à
  Uptime ? » ;
- se règle **sur l'élément** : ses réglages → Permissions. C'est le bon endroit
  parce que la question qu'on se pose est « qui voit cette base ? », posée
  devant la base ;
- un élément masqué **disparaît des listes** plutôt que d'y figurer grisé ;
- gardé par `workspace.roles` : restreindre un élément, c'est régler ce qu'un
  rôle voit ;
- `ctx.itemRestrictions(feature)` côté lecture, `ctx.assertItem(feature, id,
  level)` côté commande — chargés paresseusement, mémoïsés sous `accessEpoch`,
  invalidés par `share.grantSet`.

## 6. Reste à faire

- `mail.oauthStart` est déclarée dans les contrats mais **n'a aucun handler**.
  Antérieur à ce chantier ; la commande est morte et devrait disparaître.
