# Le partage inter-espaces — une donnée, plusieurs fenêtres

> Écrit le 20 août 2026, à la fin du lot C du chantier d'unification. Il dit
> **pourquoi** ; le code dit comment.
>
> Documents voisins : [../../WORKSPACES.md](../../WORKSPACES.md) §2 et §10,
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

Aujourd'hui : **Uptime et Bases de données**. Les autres sont refusés
franchement, avec la vraie raison affichée. Brancher une fonctionnalité de plus
tient en trois gestes : `listVisible` / `findVisible` dans son dépôt, le codec
par ligne dans son listage, une entrée dans `SHARE_WIRED`.

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

Contrôle mené sur base de copie : un contenu chiffré dans un espace **doté de sa
propre clé** (WDK) est illisible avec la clé d'un autre espace, et lisible avec
la sienne. Le codec d'origine est donc *indispensable et suffisant*.

> Attention en relisant un contrôle de ce genre : deux espaces d'un même
> propriétaire, dont aucun n'a de WDK, résolvent la **même** clé. Ce n'est pas
> une fuite mais le levier L3 — c'est simplement un couple qui ne prouve rien.
> Le contrôle doit viser un espace converti.

---

## 4. On ne partage qu'avec soi-même

La liste proposée est celle des espaces **dont l'appelant est membre**, espace
personnel compris. Ce n'est pas une restriction d'écran mais la règle, et le
serveur la vérifie : partager vers un espace où l'on n'entre pas déposerait une
donnée dont on ne pourrait plus répondre, et contournerait l'appartenance — la
frontière absolue du modèle (`WORKSPACES.md` §3).

Deux corollaires, gardés côté serveur :

- **on ne re-projette pas ce qu'on ne fait que voir.** Régler le partage d'un
  élément se fait depuis son espace d'origine. Sinon un membre de B pourrait
  diffuser vers C une donnée de A dont il n'est que spectateur, et A perdrait la
  maîtrise de sa donnée sans le savoir.
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

## 8. Reste à faire

- Brancher `listVisible` sur Git, Déploiement, Audience, Sauvegardes (`'open'`),
  puis sur les `'perItem'` avec leur test de palier ligne à ligne.
- L'ordonnanceur de fond n'a pas changé : il sonde les éléments **d'un espace**,
  pas ce qu'on y voit. C'est voulu — sonder deux fois le même service parce
  qu'il est projeté ailleurs doublerait requêtes et incidents.
