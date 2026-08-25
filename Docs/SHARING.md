# Le partage inter-espaces — une donnée, plusieurs fenêtres

> Écrit le 20 août 2026, à la fin du lot C du chantier d'unification. Il dit
> **pourquoi** ; le code dit comment.
>
> Documents voisins : [WORKSPACES.md](./WORKSPACES.md) §2 et §10,
> [SECURITY_MODEL.md](./SECURITY_MODEL.md), [PERMISSIONS.md](./PERMISSIONS.md).

---

## 1. Partager n'est pas déplacer

`WORKSPACES.md` §10 range **déplacer** un élément d'un espace à un autre hors
périmètre, et la raison est juste : ce serait la seule opération du système à
exiger un déchiffrement clé A puis un re-chiffrement clé B sous session vivante.
Tout le reste est sans re-chiffrement — c'est le levier L3, et le principal
réducteur de risque du chantier des espaces.

Ce chantier ne le contredit pas. Un élément partagé garde **un seul domicile** :
il reste chiffré sous la clé de son espace d'origine, et se lit ailleurs avec le
codec ouvert de cet espace-là. C'est une **projection**, pas un transfert. Rien
n'est re-chiffré, donc rien n'est mis en jeu.

L'élément a une seule maison et des fenêtres ailleurs.

---

## 2. Ce que ça coûte, et qu'il faut assumer

Seule la clé de l'étage **ouvert** est résoluble par le serveur seul (elle est
toujours emballée par la clé serveur). Un élément de l'étage gardé ne peut donc
pas être projeté : ce n'est pas une prudence, c'est une impossibilité mécanique.

Le registre porte la règle dans `shareTier` :

| | Partageable |
|---|---|
| `'open'` — Uptime, Bases, Déploiement, Git, Audience, Sauvegardes | oui, sans condition |
| `'perItem'` — Notes, Mail, Projets | selon la ligne : note ordinaire oui, note privée non ; compte mail « open » oui, « guarded » non |
| `'never'` — Mots de passe, CloudSync, Appareils, Météo, Finances, Sentinelle, OSINT | non |

Trois `never` méritent leur justification :

- **Appareils** ont **déjà** leur partage inter-espaces, antérieur et d'une autre
  nature : `device_workspaces` (migration 072) est une adhésion à part entière,
  pas une projection. Les deux mécanismes ne se superposent pas.
- **Mots de passe** vivent toujours à l'étage gardé. Le serveur sait les lire
  quand le chiffrement par mot de passe est éteint — mais un partage dont la
  survie dépend d'un réglage de sécurité qu'on encourage n'est pas un partage.
- **CloudSync** range ses contenus dans un magasin de blobs, chiffrés par la BMK
  et non par une clé d'espace : ce serait un autre chantier.

### `shareTier` dit ce que le chiffrement autorise, `SHARE_WIRED` ce que le code fait

Un second garde-fou, dans `features/_sharing.ts`. Projeter suppose que le
**listage** de la fonctionnalité sache aller chercher les lignes projetées et
choisir le bon codec ligne par ligne. Tant que ce n'est pas fait, la case
cocherait et rien n'apparaîtrait de l'autre côté.

Aujourd'hui : **tout l'étage `'open'`** — Uptime, Bases de données,
Déploiement, Git, Audience, Sauvegardes. Les `'perItem'` (Notes, Mail, Projets)
sont refusés franchement, avec la vraie raison affichée. Brancher une
fonctionnalité de plus tient en trois gestes : `listVisible` / `findVisible`
dans son dépôt, le codec par ligne dans son listage, une entrée dans
`SHARE_WIRED`.

### Ce qu'une fenêtre permet, par fonctionnalité

La ligne de partage est la même partout : **une fenêtre lit et agit, le
domicile configure.** Ce qui distingue les features est la nature de leurs
gestes :

| | Depuis la fenêtre | Domicile seulement |
|---|---|---|
| Uptime | tout (la ligne est autonome : réécrite sous SA clé) | supprimer |
| Bases de données | consulter, explorer, relever | modifier, supprimer, alertes |
| Déploiement | **déclencher**, historique, journal | modifier, supprimer (le jeton est une clé de SON espace) |
| Git | commits, branches, PR, releases, **synchroniser** | réglages, supprimer, rattacher un auteur |
| Audience | toutes les statistiques, entonnoirs en lecture | réglages, clé, entonnoirs, supprimer |
| Sauvegardes | fiche, historique, **déclencher** | modifier, supprimer (destination et source vivent chez lui) |

Le critère n'est pas le goût : un geste reste au domicile quand il **référence
d'autres objets de l'espace d'origine** (une clé d'API, une destination, les
membres) que la fenêtre ne voit pas — lui proposer les objets d'ici relierait
la donnée à un autre monde. Le serveur refuse, et l'écran ne propose pas.

---

## 3. Le mécanisme

`features/_sharing.ts` est **le seul endroit du dépôt qui déchiffre hors de son
espace**. Deux gardes le rendent sûr, et il faut les deux :

1. **l'étage ouvert seulement.** `cipherFor` n'expose que `.open`. L'étage gardé
   d'un autre espace serait de toute façon illisible sans le mot de passe de son
   propriétaire, mais l'exposer laisserait croire le contraire.
2. **la projection doit exister.** Le codec n'est rendu que pour un espace
   d'origine présent dans les lignes `item_shares` chargées pour cet espace et
   cette feature. Un identifiant inventé par un appelant ne donne rien.

La seconde est la vraie : sans elle, ce module serait un moyen de lire l'étage
ouvert de n'importe quel espace du serveur.

### Vérifié, pas supposé

Contrôle mené sur base de copie : un contenu chiffré dans un espace est
illisible avec la clé d'un autre espace, et lisible avec la sienne. Le codec
d'origine est donc *indispensable et suffisant*.

---

## 4. On ne partage qu'avec soi-même

La liste proposée est celle des espaces **dont l'appelant est membre**, espace
personnel compris. Ce n'est pas une restriction d'écran mais la règle, et le
serveur la vérifie : partager vers un espace où l'on n'entre pas déposerait une
donnée dont on ne pourrait plus répondre, et contournerait l'appartenance — la
frontière absolue du modèle (`WORKSPACES.md` §3).

Deux corollaires, gardés côté serveur :

- **c'est le droit au domicile qui autorise le partage, pas l'endroit où l'on
  se trouve.** Qui tient l'écriture de l'élément chez lui — membre de son
  espace d'origine, écriture sur la fonctionnalité, aucune restriction sur la
  ligne — règle son partage depuis n'importe quelle fenêtre : c'est la même
  personne devant la même donnée. Un simple spectateur de B, lui, ne peut pas
  re-projeter vers C une donnée de A : il n'a pas ce droit chez elle, et A
  garderait sinon la maîtrise de rien. Partager exige aussi l'accès à
  l'élément **lui-même** (`assertItem`) : un rôle restreint sur la ligne ne la
  projette pas vers son espace personnel pour lire par la fenêtre ce qui lui
  est fermé.
- **on ne supprime pas depuis une fenêtre.** Retirer la projection, oui ;
  détruire l'élément, seulement depuis chez lui.

---

## 5. Les références opaques

Le cas que ce chantier devait résoudre : un élément projeté vers B pointe une
donnée de A — un compte mail, un canal d'alerte. Un membre de B qui n'est pas
membre de A doit **savoir que le lien existe** sans en connaître le contenu.

Les deux extrêmes sont pires. Masquer le lien ferait passer un élément
correctement réglé pour un élément incomplet, et donnerait envie de le re-régler
par-dessus. Le montrer ferait fuiter le contenu d'un espace où l'on n'entre pas.

La ligne grise dit la vérité : « il y en a un, il ne vous regarde pas ».
`foreignChannels()` rend le **genre** de la destination — « Salon Discord d'un
autre espace » — jamais son identité, avec `usageCount: 0` et `ready: false`,
parce que ces deux nombres parlent de l'espace d'origine et se liraient ici comme
des chiffres locaux.

Régler les canaux d'un élément projeté est **refusé depuis la fenêtre** : ces
canaux appartiendraient à l'espace d'ici, alors que l'ordonnanceur qui sonde
l'élément tourne dans le sien et ne les résoudrait pas. Un écran qui laisserait
cocher produirait un réglage muet.

---

## 6. Les droits par élément

`item_role_grants` — **restrictif seulement**. `none` masque, `read` passe en
lecture seule ; rien n'élève. Le droit de feature reste le plafond.

### Une vue d'ensemble, pas une liste d'exceptions

L'écran (`ItemGrantsPanel`, un seul composant pour ses deux points de montage)
affiche **chaque rôle avec son droit effectif** : l'exception posée, ou, à
défaut, ce que la fonctionnalité lui donne — « Comme la fonctionnalité
(lecture et écriture) ». Une vue qui ne montrerait que les exceptions
obligerait à deviner le reste. Le serveur rend tout en une commande
(`share.grantList` : rôles de l'espace visé, hérité, exception), pour que
l'écran n'ait aucun recoupement à faire.

### Se règle d'où l'on est

`share.grantList` / `share.grantSet` prennent un `workspaceId` : l'espace visé,
qui n'est pas forcément l'actif. Depuis l'onglet Partage du domicile, chaque
espace coché porte un bouton **Permissions** qui ouvre le même panneau pour ce
côté-là — on règle toutes les fenêtres sans changer d'espace. Trois gardes :
membre de l'espace visé, l'élément y est réellement visible, et — pour écrire —
y tenir `workspace.roles` (`grantsManageable` dans `share.get` dit au client
quand montrer le bouton).

### Partager exige l'accès à l'élément

`share.get` et `share.set` passent par `assertItem` : un rôle **restreint sur
la ligne** (masquée, ou en lecture seule) ne peut ni voir où elle est projetée
ni la projeter. Sans cette garde, la restriction se contournait en projetant
l'élément vers son espace personnel et en lisant par la fenêtre.

L'alternative — permettre d'élever — a été écartée : l'accès effectif à une
fonctionnalité deviendrait « le maximum entre le rôle et le meilleur droit
d'élément », donc une requête de plus dans la résolution d'accès, et surtout un
écran des rôles qui ne dirait plus à lui seul qui voit quoi. Il faudrait
parcourir chaque élément de l'espace pour répondre à « qui a accès à Uptime ? ».

**L'absence de ligne vaut « rien de particulier ».** C'est ce qui rend la table
petite : seules les exceptions y figurent.

La restriction porte l'espace **depuis lequel** elle s'applique : un élément
projeté dans deux espaces peut y être restreint différemment, les rôles n'étant
pas les mêmes des deux côtés.

`ctx.itemRestrictions(feature)` est chargé **paresseusement, par feature**, et
mémoïsé dans le scope — lui-même mémoïsé sous `accessEpoch`. `share.grantSet`
appelle donc `invalidateAccess()`, sans quoi la restriction ne mordrait qu'à la
reconnexion suivante.

Un élément masqué **disparaît de la liste** plutôt que d'y figurer grisé : une
ligne qu'on voit sans pouvoir l'ouvrir apprend déjà qu'elle existe.

---

## 7. Le ménage

Ni `item_shares` ni `item_role_grants` n'ont de clé étrangère vers l'élément :
il vit dans une table différente selon la feature. Le nettoyage est **applicatif,
à la suppression** (`itemSharing.forgetItem`) — même choix que
`notification_routes` (087). Sans lui, une ligne orpheline s'appliquerait au
prochain élément à hériter de l'identifiant.

## 8. La diffusion traverse la projection

`LiveHub.changed` rejoue chaque sujet de feature branchée au partage dans les
espaces **reliés** par `item_shares`, dans les deux sens (résolveur posé par
`app.ts`). C'est fait dans le hub et pas chez les appelants, exprès : le
dispatcheur, les services de fond et le moteur de sauvegardes appellent tous
`changed`, et aucun n'a à connaître la règle. Une sonde qui écrit chez elle
rafraîchit ses fenêtres ; un déclenchement fait depuis une fenêtre rafraîchit
le domicile.

Les commandes `share.*` portent leur fonctionnalité en entrée : le dispatcheur
lit le sujet dans la requête et prévient aussi l'espace visé — nécessaire au
retrait, que la table ne relie déjà plus.

Les **compteurs** suivent la même règle que les listes : les cartes de
l'accueil comptent les éléments visibles — projetés compris, restrictions
déduites. Une carte qui compte autre chose que la liste qu'elle ouvre se lit
comme un bug.

## 9. Reste à faire

- Brancher les `'perItem'` (Notes, Mail, Projets) avec leur test de palier
  ligne à ligne — chacun est un chantier en soi : leurs objets sont des graphes
  (dossiers, messages, cartes), pas des lignes.
- L'ordonnanceur de fond n'a pas changé : il sonde les éléments **d'un espace**,
  pas ce qu'on y voit. C'est voulu — sonder deux fois le même service parce
  qu'il est projeté ailleurs doublerait requêtes et incidents.
