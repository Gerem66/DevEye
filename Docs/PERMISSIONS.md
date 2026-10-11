# Les permissions : qui a le droit de quoi

Ce document dit **pourquoi** ; le code dit comment. Documents voisins :
[WORKSPACES.md](./WORKSPACES.md) (§3), [SHARING.md](./SHARING.md) (§6, les
surcharges par élément), [NOTIFICATIONS.md](./NOTIFICATIONS.md).

---

## 1. Les quatre étages

| #   | Étage                       | Où                                           | Ce qu'il tranche                                                         |
| --- | --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Compte DevEye               | `users.role`                                 | administrateur, modérateur ou utilisateur : pages système, modération    |
| 2   | Appartenance à l'espace     | `workspace_members`                          | la frontière absolue : même un administrateur n'entre pas chez autrui    |
| 3   | Rôle : capacités + features | `workspace_roles.capabilities` / `.features` | gouverner l'espace ; ouvrir une fonctionnalité en lecture ou en écriture |
| 4   | Surcharges par élément      | `item_role_grants`                           | ce qu'un rôle fait de **cette** ligne-là, en surcharge de l'étage 3      |

L'étage 4 **surcharge** l'étage 3 : ce que le rôle accorde n'est qu'un défaut,
hérité par tous les éléments, et un élément peut le remplacer dans les deux
sens. L'absence de ligne au niveau 4 vaut « comme la fonctionnalité » : seules
les surcharges existent en base.

Un **plancher** subsiste, et c'est lui qui garde sa valeur à l'étage 3 : sans
au moins la lecture sur la fonctionnalité, aucun élément n'existe pour le rôle
et rien ne se surcharge. « Qui a accès à Appareils ? » se répond donc toujours
sur l'écran des rôles ; seul « qu'en fait-il, appareil par appareil ? »
demande d'aller voir les éléments.

L'étage 1 connaît trois rôles. L'**administrateur** tient l'instance : pages
système (journal, comptes, maintenance), chiffres de chaque fonctionnalité. Le
**modérateur** traite ce qui attend une décision humaine : les retours, et les
onglets de modération que les fonctionnalités déclarent (`manifest.adminTabs`,
les signalements). Pour le reste, il est un utilisateur : la maintenance d'une
fonctionnalité le refuse comme les autres, il prend une place d'admission, son
offre s'applique. Il voit le contenu d'un signalement, jamais d'où il vient :
l'adresse IP et l'e-mail de son auteur restent à l'administrateur, qui modère
aussi.

Les **appareils** ne relèvent pas de l'étage 1 : un appareil habite l'espace où
il a été appairé, et tout ce qui le concerne (l'appairer, l'approuver, le
renommer, le révoquer, le supprimer, lui parler) relève du droit `devices` de
cet espace, doublé de la surcharge par élément. L'administrateur global n'a
rien de particulier sur un espace où il n'entre pas.

## 2. Une décision actée : pas d'étage intermédiaire

Il n'y a pas de droits fins par geste (`deploy.trigger`, `database.execute`)
ni de matrice rôles × droits : **la granularité utile est celle des espaces et
celle des éléments, pas celle des gestes.** Pour donner moins qu'`écriture`
sur une fonctionnalité, on donne `lecture` ; pour faire un sous-groupe, on
restreint **des éléments** (« ce rôle ne voit pas cette base »), pas des verbes
(« ce rôle ne peut pas exporter »). Un étage de verbes ajouterait une matrice à
relire, une capacité à comprendre, une règle d'intersection à maintenir aux
deux bouts, pour un pouvoir d'expression que personne n'exerce.

Trois choses tiennent indépendamment de cette décision :

- **le contrôle de démarrage** (§4) : aucune commande sans garde déclarée ;
- **le registre des fonctionnalités** (`FEATURE_REGISTRY` de `@deveye/types`,
  étalé par les manifests) : le descriptif dit une fois, au lieu de copies qui
  divergent ;
- **les droits par élément** (§5) : le vrai quatrième étage.

La frontière exacte de cette décision : pas de droit par **geste**, mais des
réglages par fonctionnalité. Un grant de feature peut porter des champs en plus
de `access` quand la chose réglée appartient à la fonctionnalité : `channels`
(« gérer ses canaux d'alerte ») en est le premier, chaque émetteur possédant
ses canaux. La règle de tri : un **verbe** d'une fonctionnalité
(`deploy.trigger`) reste couvert par `read`/`write` ; une **ressource** de la
fonctionnalité (ses canaux) peut recevoir son propre champ.

Les `extraPermissions` du manifest sont la forme générale de ce champ, ouverte
aux modules : dix au plus par fonctionnalité (`MAX_EXTRA_PERMISSIONS`, pour que
l'éditeur de rôles reste lisible), en booléen (`toggle`, absent = refusé) ou en
choix borné (`choice`, deux à cinq options, absent = la moins privilégiée). Elles
obéissent à la même règle de tri, et ne rouvrent pas l'étage absent : Météo et
Veille CVE y mettent « gérer les clés d'API » (`manageKeys`), une ressource
d'espace qu'on ne veut pas livrer avec l'écriture.

Projets en porte six, qui découpent son écriture en surfaces du projet :
« gérer les projets » (`manageProjects` : créer, archiver, classer un projet,
poser son statut et sa version, tenir les colonnes de son tableau), « créer et
archiver des tâches » (`tasks`), « modifier la planification » (`plan` : les
dates sur la frise, les jalons, les dépendances), « gérer les liaisons »
(`links` : ce qui rattache le projet à un dépôt, une cible, une base, un site,
un service surveillé), « consulter l'historique » (`history`) et « participer
à la discussion » (`chat`). Ce que `write` seul laisse, c'est participer au
tableau : modifier les tâches qui existent et les déplacer. La planification
connaît une exception, tenue dans le handler par `ctx.items.canExtra` : chacun
date les tâches qui lui reviennent sans tenir le droit de planifier le projet.

Appareils en est le cas le plus large : le terminal distant, l'explorateur de
fichiers, les logs de l'appareil, les conteneurs Docker, l'accès au réseau de
l'appareil et les commandes et mises à jour système sont six **surfaces de la
machine** (`terminal`, `files`, `logs`, `docker`, `network`, `system`), et non
six verbes de la fonctionnalité. Elles sont **orthogonales** à `read`/`write`,
qui gouverne la flotte (voir, appairer, approuver, renommer, révoquer,
régler) : un gestionnaire de parc n'a pas besoin d'un shell root, un support a
besoin du shell sans pouvoir révoquer. Chacune exige la lecture, et la
surcharge par élément (§5) s'applique par-dessus : un appareil masqué ou en
lecture seule pour le rôle ne prend aucun ordre, quelle que soit la permission,
et un appareil peut au contraire ouvrir une permission que le rôle n'a pas
ailleurs.

Côté serveur, `access.extras` se déclare à côté de `access.feature` et le
dispatcheur l'applique après le niveau, en le résolvant contre les specs du
manifest : une clé que le manifest ne déclare pas ne peut jamais valoir
« accordée ». Le contrôle de démarrage refuse un `extras` sans `feature`, faute
de quoi le dispatcheur ne saurait pas où chercher la spec et laisserait passer.
Les commandes des modules passent par la même porte : `moduleFeatureHandlers`
reporte leur `extras` et leur `item` dans la garde native. Une commande qui
nomme son élément (§5) voit ses permissions éprouvées sur lui, surcharge
comprise ; une commande qui n'en nomme aucun (poser une clé d'API) les exige du
rôle.

Côté interface, le menu « Fonctions » d'un appareil **ne varie jamais** : rien
n'y est masqué, et ce qui empêche un geste se lit sur lui, par un glyphe à
droite et une phrase en infobulle. C'est l'exception assumée à la règle de §5
(« un élément masqué disparaît des listes ») : il ne s'agit pas d'un élément,
mais de ce qu'on peut en faire, et cacher laisse croire que la machine ne sait
pas le faire.

Les motifs vivent dans `features/devices/src/client/availability.ts`, et
`firstReason` rend le premier qui s'applique, dans l'ordre où le menu les donne :
**le droit prime sur l'état de la machine**, parce que rallumer un appareil ne
rendra pas une permission, et qu'afficher « hors ligne » sur un geste que le
rôle interdit de toute façon enverrait corriger la mauvaise chose.

| Motif                                     | Glyphe     |
| ----------------------------------------- | ---------- |
| Permission propre manquante               | `lock`     |
| Droit d'écriture manquant                 | `lock`     |
| Appareil venu d'un autre espace           | `users`    |
| Appareil archivé                          | `archive`  |
| Appareil en attente d'approbation         | `clock`    |
| Réservé à l'administrateur de l'instance  | `lock`     |
| Agent trop ancien pour la fonction        | `cloud`    |
| Refusé par la politique locale de l'agent | `lock`     |
| Appareil hors ligne                       | `x-circle` |
| Appareil en pause, au-delà de l'offre     | `pause`    |

Le motif suit ce que le serveur ferait réellement, geste par geste, et non un
blocage en bloc. L'infobulle d'une permission manquante nomme l'intitulé **du
manifest**, celui-là même que l'éditeur de rôles affiche : elle désigne la case
à cocher.

## 3. Le rôle s'édite entier, dans sa popup

`RoleDialog` (`client/src/Features/Workspace/RoleDialog.tsx`) porte tout : nom,
couleur, capacités, accès et réglages par fonctionnalité. L'usage réel est
« configurer CE rôle », et couper un rôle en deux écrans (son identité ici, ses
droits dans une matrice) obligerait à savoir lequel des deux détient quoi. Sa
forme est celle de la coquille de réglages (navigation à gauche : « Espace » en
tête, puis une entrée par fonctionnalité). Les intitulés viennent du registre
et des manifests, jamais d'une table locale. Une seule capacité gouverne les
rôles, `workspace.roles` : existence **et** contenu, parce qu'un découpage plus
fin produit des demi-refus illisibles sur un même formulaire.

## 4. Une déclaration, pas une garde écrite à la main

```ts
export interface FeatureAccessSpec {
    feature?: FeatureId;
    level?: FeatureAccess; // défaut 'read'
    extras?: readonly string[]; // permissions propres à `feature` (§2)
    capabilities?: WorkspaceCapability[];
    admin?: true; // l'administrateur seul
    moderation?: true; // un modérateur ou un administrateur
    scope?: 'account';
}
```

Appliqué par le dispatcheur **avant** le handler, comme la validation zod
(`src/features/_define.ts`, `src/ws/handler.ts`). `admin` et `moderation`
valent pour une commande de module comme pour une native : la projection d'un
module (`src/features/_sdk/register.ts`) les reporte dans sa spec native, et le
dispatcheur les éprouve par `assertDeclaredRole` (`src/features/_access.ts`),
avant le droit de la fonctionnalité.

### Le contrôle de démarrage

Une commande sans `access` est appelable par un membre dont le rôle n'accorde
pas la feature : l'interface seule est masquée, et la diffusion en direct
filtre, ce qui rend la faille invisible. D'où `assertAccessDeclared()`
(`src/features/_permissions.ts`), appelé au boot : le serveur **refuse de
démarrer** si une commande n'est gardée par rien et ne figure pas dans
`ACCESS_EXEMPT`. Les exemptions sont documentées sur place ; les principales :
le cycle de vie de l'espace (garde sur la ligne, `isOwner`), ce que tout
membre doit lire (`workspace.roleList`), ce que tout compte connecté peut faire
(`feedback.submit`), et ce dont la cible est un argument (`notify.*`,
`share.*`, `links.*`, `domain.*`), vérifié en tête de handler.

## 5. Les surcharges par élément

Le quatrième étage, décrit en détail dans [SHARING.md](./SHARING.md) §6. Ce
qu'il faut en retenir ici :

- **surcharge, pas restriction** : `none` masque, `read` passe en lecture
  seule, `write` ouvre l'écriture à un rôle qui ne l'a qu'en lecture ailleurs.
  Ce que la fonctionnalité donne n'est que le défaut hérité par tous les
  éléments. Une règle « restrictif seulement » laisserait l'écran des rôles
  répondre seul à « qui a accès à Uptime ? », mais interdirait le cas courant :
  confier UNE machine à quelqu'un sans lui confier la flotte. Le **plancher de
  visibilité** (§1) garde l'essentiel de cette propriété ;
- **deux volets sur la même ligne** : le niveau, et les permissions propres de
  la fonctionnalité (§2) que CET élément accorde ou retire au rôle : donner le
  terminal à un rôle sans le lui donner sur cette machine-là, ou l'inverse.
  `access` est nullable, une ligne pouvant n'exister que pour des permissions
  surchargées ; une ligne dont les deux volets sont vides est supprimée,
  l'absence restant ce qui exprime « comme la fonctionnalité ». Les booléens
  seulement : un choix borné n'a pas d'ordre que le socle sache poser, il reste
  réglé sur le rôle ;
- **la commande nomme son élément** dans `access.item` : le champ de son
  entrée qui le porte (`'databaseId'`), ou la fonction qui le retrouve quand
  elle passe par une autre ligne (le projet d'une carte, la base d'une
  alerte). Le dispatcheur éprouve alors le niveau et les permissions propres
  sur CET élément, surcharge comprise, avant le handler. Une commande qui n'en
  nomme aucun (ajouter, réordonner, régler un accès ou une destination) exige
  le droit du rôle sur la fonctionnalité : une surcharge n'ouvre jamais un
  geste qui ne vise pas son élément. Le contrôle de démarrage refuse un champ
  que l'entrée ne porte pas ;
- se règle **sur l'élément** : ses réglages → Permissions. C'est le bon endroit
  parce que la question qu'on se pose est « qui voit cette base ? », posée
  devant la base ;
- un élément masqué **disparaît des listes** plutôt que d'y figurer grisé ;
- gardé par le champ **`itemPermissions`** du grant de la fonctionnalité, ou
  par la capacité `workspace.roles` qui l'englobe : on peut confier le réglage
  par appareil sans ouvrir l'écran des rôles. Ce droit-ci ne se surcharge PAS
  par élément, sans quoi il servirait à s'accorder tout le reste ;
- `ctx.itemRestrictions(feature)` et `ctx.itemExtraOverrides(feature)` côté
  lecture, `ctx.assertItem(feature, id, level)` côté commande : une seule
  requête pour les deux volets, chargée paresseusement, mémoïsée sous
  `accessEpoch`, invalidée par `share.grantSet` (`invalidateAccess`,
  `src/features/_access.ts`) ;
- **l'interface reçoit les surcharges avec ses droits**
  (`WorkspacePermissions.itemOverrides`), et `canFeature` / `canExtra` prennent
  un `itemId` optionnel pour répondre élément par élément. Sans cela, une
  permission ouverte sur UNE machine resterait grisée dans l'écran : la garde
  serveur l'accepterait, l'interface la refuserait. Seules les exceptions
  voyagent, et le propriétaire n'en reçoit aucune, lui qui passe outre.

### Le droit d'une autre fonctionnalité, et le droit sans session

Un module ne nomme que ses propres permissions dans son `access`. Quand son
geste touche la surface d'une autre fonctionnalité, il demande un verdict à
l'app au lieu de lire un rôle : `ctx.deveye.devices.authorize(id, { extras })`
éprouve les permissions d'Appareils de l'appelant sur CETTE machine, avec la
règle des commandes natives (une machine passée en lecture seule pour son rôle
ne prend pas d'ordre). Sauvegardes l'exige pour écrire des archives sur une
machine ou en archiver un dossier : c'est la surface Fichiers. Même sans
`extras`, une machine masquée pour le rôle reste introuvable, `level: 'write'`
refuse celle qu'il n'a qu'en lecture, et `devices.list()` ne rend que celles
qu'il voit : un module ne montre ni ne règle une machine qu'Appareils lui cache.

Faire agir une machine demande en plus, quel que soit le rôle, un code
d'application récent dans la session (`control: true`, voir
[SECURITY_MODEL.md](./SECURITY_MODEL.md#lagent)). C'est une règle par
personne, pas par rôle : un membre sans double authentification voit les
machines de l'espace, il ne les pilote pas.

Un travail planifié s'exécute longtemps après que son auteur l'a réglé. Le
service d'un module relit donc les droits de cet auteur à chaque passage, sans
session (`deps.access.feature` pour les siens, `deps.access.device` pour une
machine) : compte actif, appartenance, rôle, surcharge de l'élément,
permissions. Un droit retiré, un compte suspendu ou un départ de l'espace
arrêtent le travail suivant, qui le dit. Côté app, `memberVerdict` et
`deviceVerdict` (`src/features/_access.ts`) portent ces règles.
