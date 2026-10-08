# Les espaces de travail dans DevEye

> Ce document dit **pourquoi** les espaces, les rôles et leurs clés sont ainsi ;
> le code dit comment. Documents voisins : [LIVE.md](./LIVE.md) (qui est là, et
> où), [SHARING.md](./SHARING.md) (un élément visible depuis plusieurs espaces),
> [PERMISSIONS.md](./PERMISSIONS.md) (les quatre étages de droits),
> [SECURITY_MODEL.md](./SECURITY_MODEL.md) (les clés) et
> [FEDERATION.md](./FEDERATION.md) (les espaces d'un autre serveur).

---

## 1. Ce qu'est un espace

Un espace est une **instance isolée** : ses notes, mots de passe, appareils,
services surveillés, comptes mail, météo, CloudSync, son thème et la disposition
de son accueil lui appartiennent. Deux membres d'un même espace voient les mêmes
données. Basculer d'espace change tout l'écran.

Un compte peut aussi ranger sous ses espaces ceux d'un **autre serveur DevEye**
(une instance distante). Ce ne sont pas des lignes de cette base : le navigateur
ouvre là-bas sa propre session, et tout ce qui suit décrit chaque serveur pris
seul. Voir [FEDERATION.md](./FEDERATION.md).

Deux natures, portées par `workspaces.kind` :

|                    | `personal`             | `shared`             |
| ------------------ | ---------------------- | -------------------- |
| Combien par compte | exactement un          | autant qu'on veut    |
| Membres            | son propriétaire, seul | plusieurs            |
| Supprimable        | non                    | par son propriétaire |
| Clé de chiffrement | celle du compte        | la sienne (cf. §5)   |
| Rôles              | aucun                  | oui                  |

**Terme d'interface : « espace ».** Court, tient dans un menu, se décline
(Espace personnel, Nouvel espace, Quitter l'espace). Le code garde `workspace`.

L'espace personnel est une vraie ligne de `workspaces`, pointée par
`users.personal_workspace_id` (NOT NULL, index unique `uniq_personal_workspace`).
Ce pointeur plutôt qu'un index unique sur `(kind, owner_user_id)` : ce dernier
limiterait chaque compte à un seul espace _partagé_ possédé, ce qui est faux.
Toute requête de donnée filtre sur `workspace_id` : c'est la colonne qui
cloisonne, `user_id` ne sert qu'à l'attribution.

---

## 2. Les trois leviers d'architecture

Tout tient sur ces trois choix. Ils sont ce qui rend le système maintenable
plutôt qu'un semis de cas particuliers.

### L1 : l'espace actif voyage sur l'enveloppe WS

`clientMessageSchema` (`src/protocol/envelope.ts` de `@deveye/types`) porte un
`workspaceId` optionnel. `ws.send` l'estampille depuis `stores/workspace` au
moment de l'envoi. Conséquence : aucun schéma d'entrée ne porte `workspaceId`,
aucun site d'appel ne le passe à la main, et le dispatcheur est **le seul point
de résolution**.

L'alternative, un espace actif mémorisé dans la session serveur, ne tient pas :
la socket se reconnecte seule (backoff, focus), et une commande émise avant que
la ré-activation n'arrive viserait le mauvais espace.

### L2 : l'autorisation est déclarative

`FeatureDefinition` porte un `access?: FeatureAccessSpec`
(`src/features/_define.ts`), appliqué **par le dispatcheur avant le handler**,
exactement comme la validation zod :

```ts
export interface FeatureAccessSpec {
    feature?: FeatureId; // la fonctionnalité touchée
    level?: FeatureAccess; // 'read' par défaut, 'write'
    extras?: readonly string[]; // permissions propres de la fonctionnalité, toutes exigées
    capabilities?: WorkspaceCapability[]; // capacités de gouvernance, toutes exigées
    admin?: true; // administrateur global : pages système
    scope?: 'account'; // force l'espace personnel de l'appelant
}
```

`scope: 'account'` est essentiel : pour `secrecy.*`, `twofa.*`, le changement de
mot de passe, le dispatcheur **force** `ctx.workspace` à l'espace personnel de
l'appelant quelle que soit l'enveloppe. Sans lui, une enveloppe pointant un
espace partagé pourrait détourner `secrecy.enable`.

Un contrôle au démarrage (`assertAccessDeclared`,
`src/features/_permissions.ts`) **refuse le boot** si une commande n'a ni
`access` ni entrée dans `ACCESS_EXEMPT` (la liste des commandes ouvertes à tout
compte connecté : `workspace.activate`, `workspace.add`, `feedback.submit`…).
Lever plutôt qu'avertir : un avertissement se range dans le bruit des journaux,
et la commande reste ouverte pendant ce temps.

### L3 : chaque espace a sa clé, et un contenu n'en change presque jamais

Un espace partagé a sa propre clé de données (WDK), posée à sa création ; un
espace personnel utilise les DEK de son propriétaire, qui en est le seul membre
(cf. §5). Un contenu est chiffré sous la clé de son espace et n'en change pas :
partager le projette sans le re-chiffrer ([SHARING.md](./SHARING.md)). Deux
exceptions, et elles se comptent : le passage d'un étage à l'autre à l'intérieur
d'un espace personnel (projets, comptes mail, notes privées), et **déplacer** un
élément d'un espace à un autre (§8), qui n'existe que pour les fonctionnalités
ayant écrit leur conversion. Toute nouvelle exception se paie d'un arbre qu'on
peut rendre illisible sans s'en apercevoir : c'est le principal réducteur de
risque du modèle.

---

## 3. Rôles et permissions

Deux dimensions **orthogonales**, volontairement
(`src/domain/workspaceRole.ts` de `@deveye/types`).

**Capacités** : enum fermé et court, sur la _gouvernance_ de l'espace :

```
workspace.manage      renommer, logo, supprimer
workspace.members     ajouter par adresse, exclure, attribuer un rôle
workspace.roles       créer, modifier, supprimer, ordonner les rôles
workspace.appearance  thème de l'espace
workspace.layout      disposition de l'accueil
```

Gérer les canaux d'alerte d'une fonctionnalité n'est pas une capacité : c'est le
champ `channels` du grant de feature, confié fonctionnalité par fonctionnalité
(voir [NOTIFICATIONS.md](./NOTIFICATIONS.md) §5).

**Droits par feature** : une carte uniforme `feature → read | write`, absent =
aucun accès. Vingt entrées pour les fonctionnalités du dépôt
(`workspaceFeatureIdSchema`, de `devices` à `invoicing`), plus les identifiants
`x-…` des modules externes (`featureIdSchema`). Le droit `devices` couvre la
tuile de supervision des appareils.

> Une nouvelle feature coûte **une entrée dans un tableau const** et hérite du
> gating lecture/écriture sans toucher ni l'enum ni un handler.

Chaque grant porte, à côté de `access` :

- `channels` : gérer les canaux d'alerte de cette fonctionnalité ;
- `itemPermissions` : régler ce que chaque rôle peut faire d'un élément pris
  séparément (l'onglet Permissions d'un élément), distinct de la capacité
  `workspace.roles` qui gouverne les rôles eux-mêmes ;
- `extras` : les permissions propres déclarées par la feature
  (`extraPermissions` du manifest, voir [PERMISSIONS.md](./PERMISSIONS.md) §2).

Tableau de paires plutôt que `z.record` : en zod, `z.record(enum, v)` est
exhaustif et exigerait toutes les clés.

`devices.view` / `devices.manage` sont exprimés comme `devices: read|write`
plutôt que comme capacités : un seul mécanisme, et pas de double garde où la
supervision exigerait à la fois un droit feature et une capacité.

### Résolution, dans l'ordre

1. **non-membre** → `forbidden`. L'appartenance est la frontière, sans exception :
   même un administrateur global n'entre pas dans l'espace d'autrui.
2. **propriétaire** → tout, non révocable, **sans ligne de rôle**. Lui en donner
   une laisserait croire qu'on peut le lui retirer.
3. **membre avec rôle** → exactement ce que son rôle accorde.
4. **membre sans rôle** → rien. _Fail-closed_ : un oubli d'attribution retire
   l'accès, il ne le donne jamais.

Un membre dont l'adhésion est en pause par l'offre du compte (`memberPausedIn`)
est traité comme non-membre.

### Le quatrième étage : les restrictions par élément

Il n'y a pas de droits par verbe (« déclencher un déploiement », « ouvrir le
terminal SQL ») : la granularité utile est celle des espaces et celle des
éléments ([PERMISSIONS.md](./PERMISSIONS.md) acte la frontière). Le quatrième
étage est `item_role_grants` : ce qu'un rôle obtient d'une ligne précise
(masquée, en lecture seule, ou en écriture là où la feature ne lui donne que la
lecture), réglé dans les réglages de l'élément ([SHARING.md](./SHARING.md) §6).
Un grant de feature peut porter un **réglage** de la fonctionnalité (`channels`,
`itemPermissions`, `extras`) : les verbes sont bannis, pas les réglages.

> ### Les droits ne dépendent jamais de `workspaces.features`
>
> Cette colonne est héritée et rien ne la lit : la disposition de l'accueil vit
> dans `workspaces.home_layout`. L'intersecter avec les droits d'un rôle
> reviendrait à supprimer l'accès à des données en décochant un widget.

### L'administrateur global

Il ne contourne que les pages système (Journaux, Utilisateurs), par `admin: true`.
Les appareils n'en relèvent pas : un appareil habite l'espace où il a été
appairé, tout ce qui le concerne tient au droit `devices` de cet espace, et
`authorizeDevice` (`src/agent/authorize.ts`) ne connaît aucune dérogation. Un
administrateur ne voit d'un espace où il n'entre pas ni ses appareils ni le
reste. Il n'accède **pas** aux mots de passe ni aux notes d'autrui : ce serait
contredire [SECURITY_MODEL.md](./SECURITY_MODEL.md), et c'est de toute façon
mécaniquement impossible sur un espace personnel chiffré par mot de passe.

### Révocation immédiate

`src/features/_access.ts` mémoïse les scopes par connexion, invalidés par un
compteur `accessEpoch` global incrémenté à chaque mutation de membre, de rôle ou
de statut. Pas de minuteur, pas d'attente. **Toute mutation d'accès appelle
`invalidateAccess()`**, puis expulse ou resynchronise la salle concernée
([LIVE.md](./LIVE.md) §3).

---

## 4. Membres

On rejoint un espace **parce qu'un membre vous y met**, en désignant votre
adresse (`workspace.addMember`, capacité `workspace.members`). Immédiat, sans
acceptation, avec le rôle par défaut de l'espace, et immédiat aussi **chez
l'intéressé** s'il est connecté : le hub le vise par compte (`userChanged`, voir
[LIVE.md](./LIVE.md)), puisqu'assis dans un autre espace il ne recevrait pas la
diffusion de celui-ci. Même voie au retrait (`workspace.removeMember`), à la
suppression d'un espace, et pour les membres en place quand un administrateur
supprime l'un d'eux.

Il n'y a ni lien d'invitation ni invitation de compte : une adresse suffit à
désigner un compte existant, et un jeton n'ajouterait qu'un secret transmissible
à expirer et à révoquer, pour le même résultat.

Une adresse sans compte est refusée (« Aucun compte DevEye avec cette adresse »)
plutôt que de créer le compte : on n'invite pas, l'intéressé s'inscrit d'abord.
L'inscription publique existe (`src/auth/signupRoutes.ts`) et s'ouvre ou se ferme
par le réglage d'instance `signups` ([MAINTENANCE.md](./MAINTENANCE.md)) ; elle
est toujours ouverte tant que la base n'a aucun compte.

Le propriétaire ne quitte pas son espace et seul lui le supprime
(`workspace.leave`, `workspace.delete`) ; l'espace personnel ne se supprime pas.

---

## 5. Chiffrement : la partie à comprendre avant de toucher

### Le modèle

- **Espace personnel** → la DEK du compte. Si le chiffrement par mot de passe est
  actif, elle est emballée par ce mot de passe et le serveur ne peut rien lire.
- **Espace partagé** → sa propre clé (WDK, table `workspace_secret_keys`),
  **toujours emballée par la clé serveur**. Tout membre lit l'espace sans aucun
  mot de passe, le rôle étant la seule frontière. Les tâches de fond y travaillent
  sans session.

**Tout espace partagé naît avec sa clé** : `workspace.add`
(`src/features/workspace/add.ts`) appelle `createWorkspaceDek()` à la création,
et c'est le seul endroit qui en pose une. Un espace partagé sans clé n'est pas un
état : `resolveWorkspaceDek()` (`src/Services/SecretKeyService.ts`) le traite
comme un invariant rompu et lève.

Le prix, à assumer et à dire : **le serveur peut lire le contenu d'un espace
partagé.** C'est inévitable dès lors que tous les membres doivent y accéder sans
secret partagé entre eux.

### Deux étages de chiffrement

L'app distingue l'étage gardé (`ctx.secure`) de l'étage ouvert
(`ctx.secure.open`) ; un module choisit par `ctx.cipher('private')` ou
`ctx.cipher('server')`. Les notes et Uptime écrivent dans l'étage ouvert, Mots
de passe dans l'étage gardé. Dans un espace partagé la distinction disparaît :
la WDK sert les deux.

### Un seul palier en espace partagé

Dans un espace partagé, un palier « gardé » annoncerait une protection qu'il ne
donne pas : les deux étages y lisent la même clé, et une note privée, un compte
mail protégé ou un projet confidentiel seraient lisibles par tout membre ayant la
lecture de la fonctionnalité. **Le serveur le refuse**, avec le même message
dans les trois cas (« … n'existe que dans votre espace personnel ») :

- Notes : `assertPrivateAllowed` (`features/notes/src/server/_shared.ts`) ;
- Mail : `assertTierAllowed` (`features/mail/src/server/_shared.ts`), et le
  client ne propose que « ouvert » hors espace personnel ;
- Projets : `assertGuardedAllowed` (`features/projects/src/server/_shared.ts`).

Garder le drapeau comme simple ACL contredirait le modèle documenté.

---

## 6. Côté client

- **`stores/workspace.ts`** : singleton + `useSyncExternalStore`. L'espace actif
  est `{ instanceId, id }` ; `getActiveWorkspaceId()` (lu par `ws.send`),
  `useActiveWorkspace()`, `setActiveWorkspace()`, `resetWorkspace()`,
  `useWorkspacePermissions()`. Tout ce qui se sert d'un espace comme **clé**
  passe par `workspaceKey(ref)` : `<id>` pour un espace d'ici, `r<instance>-<id>`
  pour un espace distant.
- **Thème et disposition par espace** : clés `deveye:theme:<clé>` et
  `deveye:homeLayout:<clé>` du `localStorage`, plus `deveye:activeWorkspace` et
  `deveye:activeRemote`, écrites **synchroniquement** pour qu'il n'y ait aucun
  flash au premier paint. La déconnexion remet thème et disposition à zéro : un
  second compte sur la même machine n'hérite pas de l'apparence du précédent.
- **Re-fetch au changement d'espace** : l'epoch d'espace entre dans la clé de la
  couche keep-alive de l'accueil, donc **tout remonte**. Zéro code par feature ;
  l'alternative (un `useEffect` par feature) est une souscription à maintenir à
  la main qu'une nouvelle feature oublierait.
- **La vue ouverte survit à la bascule** quand l'accueil de la cible propose la
  même tuile et que le rôle l'ouvre ; son contenu, lui, repart de zéro par
  l'epoch ci-dessus. Sinon elle se referme.
    > **L'identité de morphe (`layoutId`) est préfixée par l'epoch d'espace**, et
    > celle de la popup est figée à son ouverture. La disposition remplacée
    > démonte puis remonte toutes les tuiles (les sections sont clés par
    > `section.id`, qui diffère d'un espace à l'autre) ; sans ce préfixe, la
    > nouvelle tuile reparaîtrait avec le `layoutId` de la popup ouverte, et
    > framer-motion, qui n'admet qu'un élément par identité, projetterait la
    > popup **dans** la tuile. Après une bascule la popup n'a donc plus de
    > partenaire et se referme par un fondu, ce qui est de toute façon plus
    > juste : sa carte d'origine n'existe plus. La composition de l'accueil d'un
    > autre espace n'est **pas** embarquée dans la session : la décision ne peut
    > tomber qu'après `workspace.activate` (qui rend disposition et droits), et
    > le contenu est démonté le temps de la bascule, faute de quoi il
    > interrogerait le nouvel espace avec les droits de l'ancien. Les vues sans
    > tuile (profil, sécurité, Journaux, gestion de l'espace) échappent à la règle :
    > elles ne sont pas composées dans l'accueil.
- **Menu de la topbar** (`Components/TopNavbar/WorkspaceSwitcher.tsx`) :
  section « Espaces » **en tête** (elle dit où l'on est, et tout ce qui suit en
  dépend), création par un « + » sur l'intitulé (« Nouvel espace »). Ce qui agit
  sur un espace se range **en retrait sous celui où l'on se trouve**, dans l'ordre
  Apparence, Organiser l'accueil, Gérer cet espace ; chacune n'apparaît qu'avec
  son droit, et la gestion seulement sur un espace partagé. La liste est donc
  rendue même quand elle n'a qu'une ligne : c'est elle qui porte ces actions.
- **Carte d'ajout** (`Pages/Home/AddTileButton.tsx`) : hors organisation, une
  carte en pointillés « Ajouter une fonctionnalité » ferme chaque section et
  ouvre le marché de l'accueil, qui pose l'élément au bout de cette section.
  Elle suit le droit `workspace.layout`, s'efface dans une section pleine et
  pendant une bascule, et garde visible une section vide qu'elle invite à
  remplir. Présente par défaut, chaque compte peut la retirer dans son Profil
  (drapeau `hideHomeAddTile`). L'accueil vide, sans section, garde ses modèles.
- **Bouton de profil** : le nom de l'espace y figure pour un espace partagé
  seulement : répéter « Espace personnel » à qui y est déjà n'apprend rien.
- **En-tête de l'accueil** (`homeHeading`, `Pages/Home/index.tsx`) :

    |           | Titre               | Sous-titre                                       |
    | --------- | ------------------- | ------------------------------------------------ |
    | Personnel | `Bonsoir, <pseudo>` | `Mercredi 5 août`                                |
    | Partagé   | le nom de l'espace  | `Bonsoir <pseudo> · 3 membres · mercredi 5 août` |

### Gating des features non accordées

**Une seule garde, dans `handleExpand`** (`Pages/Home/index.tsx`) : la tuile de
l'accueil, la navigation entre features et le menu de la topbar y aboutissent
tous. La poser dans le rendu des tuiles ne fermerait qu'une porte sur trois.

Refus → popup « Accès refusé » nommant la feature. Sur l'accueil, la tuile reste
posée mais désaturée (`.lockedTile`) et son contenu vivant cède la place à
« Accès restreint » (`Pages/Home/tiles/tileLock.tsx`) : sinon elle interroge un
serveur qui refuse et affiche des zéros qui se lisent comme des données. La
retirer déplacerait ses voisines et donnerait à lire une disposition abîmée.
Pendant une **bascule d'espace**, ce grisage est suspendu le temps de
l'aller-retour (et le clic avec) : les droits remis à zéro ne sont ceux de
personne, et la grille reste affichée telle quelle pour que les tuiles communes
aux deux espaces glissent vers leur nouvelle place.

`featureBehind(viewId)` fait la correspondance vue → feature : une
fonctionnalité du dépôt ou l'identifiant d'un module externe. Les vues de compte et
d'administration (profil, sécurité, Journaux, Utilisateurs, gestion de l'espace)
n'en dépendent d'aucune : elles ont leurs propres gardes.

---

## 7. Base de données

Les tables du modèle : `workspaces` (`kind`, `owner_user_id`, `theme`,
`home_layout`), `workspace_members` (`role_id` nullable, index unique
`uniq_workspace_member`), `workspace_roles` (`capabilities` et `features` en
JSON, `is_default`), `workspace_secret_keys` (la WDK, `dek_wrapped`),
`users.personal_workspace_id`, et pour le quatrième étage `item_role_grants`
([SHARING.md](./SHARING.md) §6).

Les migrations qui le portent (`src/db/migrations/`) :

| #       | Fichier                                                                      | Contenu                                                                                |
| ------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 046     | `workspace_kind`                                                             | `kind`, `owner_user_id`, `theme`, `home_layout` ; l'espace personnel devient une ligne |
| 047     | `users_workspace_pointer`                                                    | `personal_workspace_id`, favori ; `features`, `theme`, `home_layout` quittent `users`  |
| 048     | `scope_notes_passwords`                                                      | `workspace_id` devient la clé de cloisonnement                                         |
| 049-053 | `scope_uptime`, `scope_mail`, `scope_weather`, `scope_sync`, `scope_devices` | idem, feature par feature                                                              |
| 054     | `workspace_invites`                                                          | pose `uniq_workspace_member` (la table, elle, est supprimée en 058)                    |
| 055     | `workspace_secret_keys`                                                      | la WDK                                                                                 |
| 056     | `workspace_roles`                                                            | rôles + `members.role_id`                                                              |
| 058     | `drop_workspace_invites`                                                     | pas d'invitation par lien                                                              |
| 089     | `item_sharing`                                                               | `item_shares`, `item_role_grants` ([SHARING.md](./SHARING.md))                         |
| 093     | `role_channels_per_feature`                                                  | le champ `channels` des grants                                                         |
| 119     | `drop_user_invites`                                                          | pas d'invitation de compte                                                             |

Le `workspace_id` de `workspace_members` et de `workspace_roles` est une clé
étrangère en `ON DELETE CASCADE` ; `members.role_id` est en `ON DELETE SET
NULL` et surtout pas `RESTRICT`, qui pourrait bloquer un `DELETE FROM
workspaces` selon l'ordre, non garanti, de la cascade. Le refus de supprimer un
rôle encore porté est appliqué par le handler.

`src/db/migrate.ts` envoie chaque fichier en **une** requête, sur une connexion
multi-instructions, **sans transaction** : le DDL de MySQL committe
implicitement. Si une instruction échoue au milieu, les précédentes sont
acquises et la migration n'est pas enregistrée ; au boot suivant elle rejoue
depuis le début et échoue en doublon. D'où, sans exception : tout `ADD COLUMN`
passe par `INFORMATION_SCHEMA` + `PREPARE`/`EXECUTE`, `CREATE TABLE IF NOT
EXISTS` partout, tout backfill porte un `WHERE <pas encore fait>`, et chaque
fichier reste court et mono-objet.

---

## 8. Déplacer un élément

`share.move` change le domicile d'un élément : c'est la seule opération qui
déchiffre sous une clé pour rechiffrer sous une autre, **fonctionnalité par
fonctionnalité** : sans entrée `move` dans ses `items`, une feature ne déplace
rien, et l'écran ne le propose pas. La conversion lit et rescelle tout avant la
première écriture, dans une transaction.

Se déplacent : Uptime, Notes, Bases de données, Déploiements, Git, Audience,
Appareils, Mail, Projets, Hébergement. Pas Sauvegardes (un travail ne peut pas
exister sans destination, et sa destination appartient à l'espace qu'il
quitterait) ni Serveur mail (il se partage sans se déplacer). Le tableau de
[SHARING.md](./SHARING.md) §9 dit pour chacune ce que le déplacement emporte et
ce qu'il laisse.

Une liaison de projet vise ce que l'espace du projet voit, chez lui ou projeté,
et se pose depuis le domicile du projet ; un élément qui part emporte ses
liaisons dans la corbeille, pas ailleurs ([SHARING.md](./SHARING.md) §9).

### Hors périmètre, décidé

**Verrouiller un espace partagé derrière une phrase de passe partagée.** Ce
n'est pas un réglage à retourner : il faudrait décider qui détient le secret,
comment on l'ajoute à un nouveau membre, ce qu'il advient quand on l'exclut. Le
modèle reste : un espace partagé est lisible par le serveur, et le rôle est sa
seule frontière.
