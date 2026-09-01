# Les permissions — qui a le droit de quoi

> Réécrit le 20 août 2026, après le retour d'usage sur le chantier des droits.
> Il dit **pourquoi** ; le code dit comment.
>
> Documents voisins : [WORKSPACES.md](./WORKSPACES.md) §3,
> [SHARING.md](./SHARING.md) pour les surcharges par élément,
> [NOTIFICATIONS.md](./NOTIFICATIONS.md).

---

## 1. Les quatre étages

| #   | Étage                       | Où                                           | Ce qu'il tranche                                                         |
| --- | --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Compte DevEye               | `users.role`                                 | administrateur ou utilisateur : les pages système (journal, comptes)     |
| 2   | Appartenance à l'espace     | `workspace_members`                          | la frontière absolue — même un admin n'entre pas chez autrui             |
| 3   | Rôle : capacités + features | `workspace_roles.capabilities` / `.features` | gouverner l'espace ; ouvrir une fonctionnalité en lecture ou en écriture |
| 4   | Surcharges par élément      | `item_role_grants`                           | ce qu'un rôle fait de **cette** ligne-là, en surcharge de l'étage 3      |

L'étage 4 **surcharge** l'étage 3 : ce que le rôle accorde n'est qu'un défaut,
hérité par tous les éléments, et un élément peut le remplacer dans les deux
sens. L'absence de ligne au niveau 4 vaut « comme la fonctionnalité » — seules
les surcharges existent en base.

Un **plancher** subsiste, et c'est lui qui garde sa valeur à l'étage 3 : sans au
moins la lecture sur la fonctionnalité, aucun élément n'existe pour le rôle et
rien ne se surcharge. « Qui a accès à Appareils ? » se répond donc toujours sur
l'écran des rôles ; seul « qu'en fait-il, appareil par appareil ? » demande
d'aller voir les éléments.

Les **appareils** ne relèvent plus de l'étage 1 : un appareil habite l'espace où
il a été appairé, et tout ce qui le concerne (l'appairer, l'approuver, le
renommer, le révoquer, le supprimer, lui parler) relève du droit `devices` de
cet espace, doublé de la surcharge par élément. L'administrateur global n'a
rien de particulier sur un espace où il n'entre pas.

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
- **les droits par élément** (§5) — le vrai quatrième étage.

La frontière exacte de cette décision : ce sont les droits par **geste** qui
ont été retirés, pas les réglages par fonctionnalité. Un grant de feature peut
porter des champs en plus de `access` quand la chose réglée appartient à la
fonctionnalité : `channels` (« gérer ses canaux d'alerte », migration 093) en
est le premier, né quand la capacité d'espace `workspace.notifications` s'est
mise à confier d'un bloc l'astreinte d'Uptime et le salon des sauvegardes,
alors que chaque émetteur possède ses canaux depuis la 091. La règle de tri :
un **verbe** d'une fonctionnalité (`deploy.trigger`) reste couvert par
`read`/`write` ; une **ressource** de la fonctionnalité (ses canaux) peut
recevoir son propre champ.

Les `extraPermissions` du manifest sont la forme générale de ce champ, ouverte
aux modules : quatre au plus par fonctionnalité (`MAX_EXTRA_PERMISSIONS`, pour
que l'éditeur de rôles reste lisible), en booléen ou en choix borné, absentes =
refusées. Elles obéissent à la même règle de tri, et ne rouvrent pas l'étage
retiré : Météo et Veille CVE y mettent « gérer les clés d'API », une ressource
d'espace qu'on ne veut pas livrer avec l'écriture.

Appareils en est le cas le plus large : le terminal, l'explorateur de fichiers,
les journaux et les commandes système sont quatre **surfaces de la machine**,
et non quatre verbes de la fonctionnalité. Elles sont **orthogonales** à
`read`/`write`, qui gouverne la flotte (voir, appairer, approuver, renommer,
révoquer, régler) : un gestionnaire de parc n'a pas besoin d'un shell root, un
support a besoin du shell sans pouvoir révoquer. Chacune exige la lecture, et
la surcharge par élément (§5) s'applique par-dessus — un appareil masqué ou
en lecture seule pour le rôle ne prend aucun ordre, quelle que soit la
permission, et un appareil peut au contraire ouvrir une permission que le rôle
n'a pas ailleurs. C'est aussi ce qui a sorti les mises à jour de paquets de l'étage 1
(elles étaient `admin: true`, ce que §1 dit pourtant que les appareils ne font
plus).

Côté serveur, `access.extras` se déclare à côté de `access.feature` et le
dispatcheur l'applique après le niveau, en le résolvant contre les specs du
manifest : une clé que le manifest ne déclare pas ne peut jamais valoir
« accordée ». Le contrôle de démarrage refuse un `extras` sans `feature`, faute
de quoi le dispatcheur ne saurait pas où chercher la spec et laisserait passer.

Côté interface, le menu « Fonctions » d'un appareil **ne varie jamais** : rien
n'y est masqué, et ce qui empêche un geste se lit sur lui, par un glyphe à
droite et une phrase en infobulle. C'est l'exception assumée à la règle de §5
(« un élément masqué disparaît des listes ») — il ne s'agit pas d'un élément,
mais de ce qu'on peut en faire, et cacher laisse croire que la machine ne sait
pas le faire.

Les motifs vivent dans `client/availability.ts`, et **leur ordre est la règle** :

| Ordre | Motif                           | Glyphe     |
| ----- | ------------------------------- | ---------- |
| 1     | Permission propre manquante     | `lock`     |
| 2     | Droit d'écriture manquant       | `lock`     |
| 3     | Appareil venu d'un autre espace | `users`    |
| 4     | Appareil archivé                | `archive`  |
| 5     | Appareil hors ligne             | `x-circle` |

Le droit prime sur l'état de la machine : rallumer un appareil ne rendra pas
une permission, et afficher « hors ligne » sur un geste que le rôle interdit de
toute façon enverrait corriger la mauvaise chose. Le motif suit ce que le
serveur ferait réellement, geste par geste, et non un blocage en bloc : un
appareil archivé refuse tout **sauf** la purge de son historique
(`devices.delete` l'accepte, et c'est le seul moyen de s'en défaire), et seule
l'interruption de l'agent exige qu'il soit en ligne. L'infobulle d'une
permission manquante nomme l'intitulé **du manifest**, celui-là même que
l'éditeur de rôles affiche : elle désigne la case à cocher.

## 3. Le rôle s'édite entier, dans sa popup

Un détour a existé : l'identité du rôle dans sa popup, ses droits dans une
matrice globale. Retiré aussi — l'usage réel est « configurer CE rôle », et
couper un rôle en deux écrans obligeait à savoir lequel des deux détenait quoi.

`RoleDialog` porte donc tout : nom, couleur, capacités, accès et réglages par
fonctionnalité. Sa forme est celle de la coquille de réglages (navigation à
gauche : « Espace » en tête, puis une entrée par fonctionnalité, repliées sur
celles que l'accueil montre). Les intitulés viennent du registre, jamais d'une
table locale. Une seule capacité gouverne les rôles, `workspace.roles` :
existence **et** contenu : le découpage plus fin produisait des demi-refus
illisibles sur un même formulaire.

## 4. Une déclaration, pas une garde écrite à la main

```ts
export interface FeatureAccessSpec {
    feature?: WorkspaceFeatureId;
    level?: FeatureAccess; // défaut 'read'
    extras?: readonly string[]; // permissions propres à `feature` (§2)
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

## 5. Les surcharges par élément

Le quatrième étage, décrit en détail dans [SHARING.md](./SHARING.md) §6. Ce
qu'il faut en retenir ici :

- **surcharge, pas restriction** — `none` masque, `read` passe en lecture seule,
  `write` ouvre l'écriture à un rôle qui ne l'a qu'en lecture ailleurs. Ce que
  la fonctionnalité donne n'est que le défaut hérité par tous les éléments.
  C'est un revirement assumé : la règle « restrictif seulement » valait un écran
  des rôles qui répondait seul à « qui a accès à Uptime ? », et elle a cédé
  parce qu'elle interdisait le cas courant — confier UNE machine à quelqu'un
  sans lui confier la flotte. Le **plancher de visibilité** (§1) sauve
  l'essentiel de la propriété perdue ;
- **deux volets sur la même ligne** — le niveau, et les permissions propres de
  la fonctionnalité (§2) que CET élément accorde ou retire au rôle : donner le
  terminal à un rôle sans le lui donner sur cette machine-là, ou l'inverse.
  `access` est nullable, une ligne pouvant n'exister que pour des permissions
  surchargées ; une ligne dont les deux volets sont vides est supprimée,
  l'absence restant ce qui exprime « comme la fonctionnalité ». Les booléens
  seulement : un choix borné n'a pas d'ordre que le socle sache poser, il reste
  réglé sur le rôle ;
- **les gardes déclarées ne connaissent pas la cible** : une commande ne nomme
  son élément que dans son entrée. Le dispatcheur ne peut donc exiger qu'une
  chose en amont — le droit tenu sur la fonctionnalité, OU un élément au moins
  qui le surcharge en ce sens ; `ctx.assertItem` tranche ensuite pour l'élément
  visé. Une garde qui vérifie le niveau autrement appelle `ctx.assertItemExtras`
  seule (l'accès aux agents : piloter une machine ne suppose pas l'écriture sur
  la flotte) ;
- se règle **sur l'élément** : ses réglages → Permissions. C'est le bon endroit
  parce que la question qu'on se pose est « qui voit cette base ? », posée
  devant la base ;
- un élément masqué **disparaît des listes** plutôt que d'y figurer grisé ;
- gardé par le champ **`itemPermissions`** du grant de la fonctionnalité, ou par
  la capacité `workspace.roles` qui l'englobe : on peut confier le réglage par
  appareil sans ouvrir l'écran des rôles. Ce droit-ci ne se surcharge PAS par
  élément, sans quoi il servirait à s'accorder tout le reste ;
- `ctx.itemRestrictions(feature)` et `ctx.itemExtraOverrides(feature)` côté
  lecture, `ctx.assertItem(feature, id, level)` côté commande — une seule
  requête pour les deux volets, chargée paresseusement, mémoïsée sous
  `accessEpoch`, invalidée par `share.grantSet`.

## 6. Reste à faire

- `mail.oauthStart` est déclarée dans les contrats mais **n'a aucun handler**.
  Antérieur à ce chantier ; la commande est morte et devrait disparaître.
