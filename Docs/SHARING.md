# Le partage inter-espaces : une donnée, plusieurs fenêtres

> Ce document dit **pourquoi** ; le code dit comment. Documents voisins :
> [WORKSPACES.md](./WORKSPACES.md) §2 et §8,
> [SECURITY_MODEL.md](./SECURITY_MODEL.md), [PERMISSIONS.md](./PERMISSIONS.md),
> [FEDERATION.md](./FEDERATION.md).

---

## 1. Partager n'est pas déplacer

Un élément partagé garde **un seul domicile** : il reste chiffré sous la clé de
son espace d'origine, et se lit ailleurs avec le codec ouvert de cet espace-là.
C'est une **projection**, pas un transfert. Rien n'est re-chiffré, donc rien
n'est mis en jeu.

L'élément a une seule maison et des fenêtres ailleurs.

**Déplacer est autre chose** : `share.move` change le domicile, et c'est la
seule opération du système qui déchiffre sous une clé pour rechiffrer sous une
autre. Elle ne dément pas le levier L3 ([WORKSPACES.md](./WORKSPACES.md) §2),
elle en est l'exception déclarée : sans entrée `move` dans les `items` de sa
fonctionnalité, un élément ne bouge pas, et l'écran ne le propose pas. Voir §9.
**Copier** fait naître un double indépendant, ici ou sur une autre instance :
§10.

---

## 2. Ce que ça coûte, et qu'il faut assumer

Seule la clé de l'étage **ouvert** est résoluble par le serveur seul (elle est
toujours emballée par la clé serveur). Un élément de l'étage gardé ne peut donc
pas être projeté : ce n'est pas une prudence, c'est une impossibilité mécanique.

Le registre (`src/domain/featureRegistry.ts` de `@deveye/types`) et le manifest
de chaque module portent la règle dans `shareTier` :

|                                                                                                                                                                 | Partageable                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `'open'` : Uptime, Bases de données, Déploiements, Git, Audience, Sauvegardes, Appareils, Serveur mail, Hébergement                                             | oui, sans condition                                                                                        |
| `'perItem'` : Notes, Mail, Projets                                                                                                                              | selon la ligne : note ordinaire oui, note privée non ; compte mail ou projet « open » oui, « guarded » non |
| `'never'` : Mots de passe, CloudSync, Météo, Finances, Sentinelle, OSINT, Veille CVE, Convertisseur, Facturation, Audit, Rendez-vous, Jeu de la vie, Abonnement | non                                                                                                        |

Deux `never` méritent leur justification :

- **Mots de passe** vivent toujours à l'étage gardé. Le serveur sait les lire
  quand le chiffrement par mot de passe est éteint, mais un partage dont la
  survie dépend d'un réglage de sécurité qu'on encourage n'est pas un partage.
- **CloudSync** range ses contenus dans un magasin de blobs, chiffrés par la BMK
  et non par une clé d'espace.

### `shareTier` dit ce que le chiffrement autorise, `items` ce que le code fait

Projeter suppose que le **listage** de la fonctionnalité sache aller chercher
les lignes projetées et choisir le bon codec ligne par ligne. Le registre dit ce
que le chiffrement autorise ; l'entrée `items` du serveur du module dit que le
code le fait, et le boot refuse un module qui déclare autre chose que `'never'`
sans offrir `items` (`src/features/_sdk/register.ts`). `isShareWired`
(`src/features/_sharing.ts`) lit le manifest ; `shareBlockerFor` rend au client
la raison pour laquelle les cases d'un élément sont inertes.

Toute fonctionnalité dont le `shareTier` n'est pas `'never'` est branchée :
l'étage `'open'` et les trois `'perItem'`, avec le test de palier ligne à
ligne. Pour Notes et Mail, `items.shareable` refuse à l'entrée la note privée ou
le compte gardé, et la bascule vers le palier gardé chez soi appelle
`ctx.items.forget`, de sorte qu'aucune projection ne survit à un élément devenu
illisible ailleurs. Pour Projets : un assigné ou un auteur n'est nommé que s'il
est membre de l'espace qu'on charge (sinon « Membre hors de cet espace ») ; un
projet projeté compte dans « mes tâches » de la fenêtre ; ses liaisons sont
visibles par leur nom (`labelOf` des contrats d'éléments, sous le codec de
l'espace d'origine), sans être ouvrables ni modifiables d'ici.

Brancher un **module** : `shareTier` autre que `'never'` dans son manifest,
l'entrée `items` de son serveur (`homeOf` : le domicile d'un élément visible
d'ici ; `labelOf` : son intitulé sous le codec ouvert de l'espace appelant ;
`shareable`, facultatif : `false` pour un élément que son palier interdit de
projeter, `share.set` le demande avec le domicile et refuse en le disant),
`ctx.sharing.scope()` dans ses listages (`foreignIds`, `homeOf`, `cipherFor`,
`orderOf`, ligne par ligne) et `ctx.items.restrictions()` sur ce qu'ils rendent.

### Ce qu'une fenêtre permet, par fonctionnalité

La ligne de partage est la même partout : **une fenêtre lit et agit, le
domicile configure.** Ce qui distingue les features est la nature de leurs
gestes :

|                  | Depuis la fenêtre                                                                                                                                                                         | Domicile seulement                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Uptime           | tout (la ligne est autonome : réécrite sous SA clé)                                                                                                                                       | supprimer                                                                                 |
| Bases de données | consulter, explorer, relever                                                                                                                                                              | modifier, supprimer, alertes                                                              |
| Déploiements     | **déclencher**, historique, journal                                                                                                                                                       | modifier, supprimer (l'accès est une source de SON espace)                                |
| Git              | commits, branches, PR, releases, **synchroniser**                                                                                                                                         | réglages, supprimer, rattacher un auteur                                                  |
| Audience         | toutes les statistiques, entonnoirs en lecture                                                                                                                                            | réglages, clé, entonnoirs, supprimer                                                      |
| Sauvegardes      | fiche, historique, **déclencher**                                                                                                                                                         | modifier, supprimer (destination et source vivent chez lui)                               |
| Notes            | lire, éditer le corps, archiver, restaurer (chez elle, sous sa clé ; rangée à la racine, hors classement d'ici)                                                                           | classer (dossier, rang), passer en privée, détruire                                       |
| Mail             | dossiers, lire, marquer, déplacer, envoyer, relever, renommer, cadence, pause                                                                                                             | supprimer le compte, changer de palier, identifiants et proxy, reconnexion OAuth          |
| Appareils        | superviser, terminal, fichiers, logs, paquets, commandes système, ranger dans SA liste                                                                                                    | appairer, approuver, renommer, révoquer, régler la collecte, supprimer                    |
| Serveur mail     | lire : l'adresse et son activité                                                                                                                                                          | tout réglage et la suppression : une fenêtre projetée lit, elle ne règle pas              |
| Hébergement      | parcourir, déposer (compté sur l'offre du domicile), renommer, déplacer, supprimer et télécharger des fichiers                                                                            | adresses, domaines, mot de passe, allure, nom et suppression du dossier                   |
| Projets          | tout l'arbre (colonnes, cartes, assignation parmi les membres d'ici, jalons, dépendances, discussion, historique), profil, statut, archivage, version manuelle ; liaisons lues et nommées | changer de palier, version suivie d'une release, relier / délier, classer le portefeuille |

Le critère n'est pas le goût : un geste reste au domicile quand il **référence
d'autres objets de l'espace d'origine** (une clé d'API, une destination, les
membres) que la fenêtre ne voit pas : lui proposer les objets d'ici relierait
la donnée à un autre monde. Le serveur refuse, et l'écran ne propose pas.

---

## 3. Le mécanisme

L'identifiant d'un élément est un **texte** d'un bout à l'autre de la chaîne
(`item_shares`, `item_role_grants`, `ItemRef`, `ctx.items`, `ctx.sharing`) : une
feature choisit la clé de sa table, entière ou non, et celle d'un appareil est un
UUID. Une feature à lignes numérotées convertit au point de contact
(`String(row.id)` en écriture, `Number(itemId)` dans son entrée `items`). Les
routes de notification gardent leur clé numérique, la leur.

Le **rang** d'un élément projeté appartient à l'espace qui le reçoit
(`item_shares.sort_order`) : la même ligne se range indépendamment dans chaque
liste qui l'affiche. Chez lui, le rang reste porté par la table de la feature.
`ctx.sharing.setOrder` écrit le premier, le dépôt de la feature le second.

`src/features/_sharing.ts` est **le seul endroit du dépôt qui déchiffre hors de
son espace**. Deux gardes le rendent sûr, et il faut les deux :

1. **l'étage ouvert seulement.** `cipherFor` n'expose que le codec ouvert.
   L'étage gardé d'un autre espace serait de toute façon illisible sans le mot
   de passe de son propriétaire, mais l'exposer laisserait croire le contraire.
2. **la projection doit exister.** Le codec n'est rendu que pour un espace
   d'origine présent dans les lignes `item_shares` chargées pour cet espace et
   cette feature. Un identifiant inventé par un appelant ne donne rien.

La seconde est la vraie : sans elle, ce module serait un moyen de lire l'étage
ouvert de n'importe quel espace du serveur. Un contenu chiffré dans un espace
est illisible avec la clé d'un autre et lisible avec la sienne : le codec
d'origine est indispensable et suffisant.

---

## 4. On ne partage qu'avec soi-même

La liste proposée est celle des espaces **dont l'appelant est membre**, espace
personnel compris. Ce n'est pas une restriction d'écran mais la règle, et le
serveur la vérifie : partager vers un espace où l'on n'entre pas déposerait une
donnée dont on ne pourrait plus répondre, et contournerait l'appartenance, la
frontière absolue du modèle ([WORKSPACES.md](./WORKSPACES.md) §3).

Deux corollaires, gardés côté serveur :

- **c'est le droit au domicile qui autorise le partage, pas l'endroit où l'on
  se trouve.** Qui tient l'écriture de l'élément chez lui (membre de son espace
  d'origine, écriture sur la fonctionnalité, aucune restriction sur la ligne)
  règle son partage depuis n'importe quelle fenêtre : c'est la même personne
  devant la même donnée. Un simple spectateur de B, lui, ne peut pas re-projeter
  vers C une donnée de A : il n'a pas ce droit chez elle, et A garderait sinon
  la maîtrise de rien. Partager exige aussi l'accès à l'élément **lui-même**
  (`assertItem`) : un rôle restreint sur la ligne ne la projette pas vers son
  espace personnel pour lire par la fenêtre ce qui lui est fermé.
- **on ne supprime pas depuis une fenêtre.** Retirer la projection, oui ;
  détruire l'élément, seulement depuis chez lui.

`share.set` traite **un espace par appel** : la case de l'écran est la
commande, et un échec ne laisse pas les autres dans un état incertain.

---

## 5. Les références opaques

Un élément projeté vers B pointe une donnée de A : un compte mail, un canal
d'alerte. Un membre de B qui n'est pas membre de A doit **savoir que le lien
existe** sans en connaître le contenu.

Les deux extrêmes sont pires. Masquer le lien ferait passer un élément
correctement réglé pour un élément incomplet, et donnerait envie de le re-régler
par-dessus. Le montrer ferait fuiter le contenu d'un espace où l'on n'entre pas.

La ligne grise dit la vérité : « il y en a un, il ne vous regarde pas ».
`foreignChannels()` (`src/features/_notifications.ts`) rend le **genre** de la
destination (« Salon Discord d'un autre espace »), jamais son identité, avec
`usageCount: 0` et `ready: false`, parce que ces deux nombres parlent de
l'espace d'origine et se liraient ici comme des chiffres locaux.

Régler les canaux d'un élément projeté est **refusé depuis la fenêtre** : ces
canaux appartiendraient à l'espace d'ici, alors que l'ordonnanceur qui sonde
l'élément tourne dans le sien et ne les résoudrait pas. Un écran qui laisserait
cocher produirait un réglage muet.

---

## 6. Les droits par élément

`item_role_grants` est une **surcharge**. `none` masque, `read` passe en lecture
seule, `write` ouvre l'écriture à un rôle qui ne l'a qu'en lecture ailleurs. Ce
que le droit de feature accorde n'est plus un plafond mais un défaut, hérité par
tous les éléments jusqu'à ce que l'un d'eux le remplace.

Il reste un **plancher** : sans au moins la lecture sur la fonctionnalité,
aucun élément n'existe pour le rôle. C'est ce qui laisse à l'écran des rôles la
réponse à « qui a accès à Uptime ? » ; sans lui, il faudrait parcourir chaque
élément de l'espace pour la trouver. Seul « qu'en fait-il, élément par
élément ? » descend voir les lignes, et la requête qui les charge est celle des
surcharges, indexée et mémoïsée par feature.

La ligne porte **deux volets**. Le niveau (`access`), et les permissions propres
de la fonctionnalité (`extra_overrides`, les `extraPermissions` du manifest, cf.
[PERMISSIONS.md](./PERMISSIONS.md) §2) que cet élément-ci accorde ou retire au
rôle : donner le terminal à un rôle sur CETTE machine seulement, ou le lui
retirer ici seulement. `access` est nullable (une ligne peut n'exister que pour
des permissions surchargées) et une ligne dont les deux volets sont vides est
supprimée. Les deux se règlent séparément (`share.grantSet` laisse en place le
volet qu'on ne lui passe pas) et se lisent d'une seule requête, vivant sur la
même ligne. Seuls les booléens se surchargent : un choix borné n'a pas d'ordre
que le socle sache poser, il reste réglé sur le rôle.

### Une vue d'ensemble, pas une liste d'exceptions

L'écran (`Components/FeatureSettings/sections/ItemGrantsPanel.tsx`, un seul
composant pour ses deux points de montage) affiche **chaque rôle avec son droit
effectif** : l'exception posée, ou, à défaut, ce que la fonctionnalité lui
donne. Une vue qui ne montrerait que les exceptions obligerait à deviner le
reste. Le serveur rend tout en une commande (`share.grantList` : rôles de
l'espace visé, hérité, exception), pour que l'écran n'ait aucun recoupement à
faire.

La forme est celle de **l'éditeur de rôle** : un bloc par rôle, son identité
au-dessus, ses droits dans une carte. On y règle les mêmes droits à une autre
échelle, ce doit être la même forme. Le niveau d'abord, puis une rangée par
permission de la fonctionnalité, chacune sur le même sélecteur à segments, où
« Hérité » est une valeur parmi les autres : la valeur courante et la valeur
héritée ne se devinent pas au trait d'une bordure.

### Se règle d'où l'on est

`share.grantList` / `share.grantSet` prennent un `workspaceId` : l'espace visé,
qui n'est pas forcément l'actif. Depuis l'onglet Partage du domicile, chaque
espace coché porte un bouton **Permissions** qui ouvre le même panneau pour ce
côté-là : on règle toutes les fenêtres sans changer d'espace. Trois gardes :
membre de l'espace visé, l'élément y est réellement visible, et, pour écrire, y
tenir le champ `itemPermissions` du grant de cette fonctionnalité ou la capacité
`workspace.roles` qui l'englobe (`grantsManageable` dans `share.get` dit au
client quand montrer le bouton).

### Partager exige l'accès à l'élément

`share.get` et `share.set` passent par `assertItem` : un rôle **abaissé sur la
ligne** (masquée, ou en lecture seule) ne peut ni voir où elle est projetée ni
la projeter. Sans cette garde, la surcharge se contournerait en projetant
l'élément vers son espace personnel et en lisant par la fenêtre.

**L'absence de ligne vaut « comme la fonctionnalité ».** C'est ce qui rend la
table petite : seules les surcharges y figurent.

La restriction porte l'espace **depuis lequel** elle s'applique : un élément
projeté dans deux espaces peut y être restreint différemment, les rôles n'étant
pas les mêmes des deux côtés.

`ctx.itemRestrictions(feature)` est chargé **paresseusement, par feature**, et
mémoïsé dans le scope, lui-même mémoïsé sous `accessEpoch`. `share.grantSet`
appelle donc `invalidateAccess()` puis `resync` ([LIVE.md](./LIVE.md) §3), sans
quoi la restriction ne mordrait qu'à la reconnexion suivante.

Un élément masqué **disparaît de la liste** plutôt que d'y figurer grisé : une
ligne qu'on voit sans pouvoir l'ouvrir apprend déjà qu'elle existe.

---

## 7. Le ménage

Ni `item_shares` ni `item_role_grants` n'ont de clé étrangère vers l'élément :
il vit dans une table différente selon la feature. Le nettoyage est **applicatif,
à la suppression** (`itemSharing.forgetItem`), même choix que les routes de
notification. Sans lui, une ligne orpheline s'appliquerait au prochain élément à
hériter de l'identifiant. Un module appelle `ctx.items.forget(id)` dans son
handler de suppression : projections, restrictions et route de notification en
un geste.

## 8. La diffusion traverse la projection

`LiveHub.changed` rejoue chaque sujet de feature branchée au partage dans les
espaces **reliés** par `item_shares`, dans les deux sens (résolveur
`setShareLinks` posé par `src/app.ts` sur `itemSharing.linkedWorkspaces`). C'est
fait dans le hub et pas chez les appelants, exprès : le dispatcheur, les
services de fond, le moteur de sauvegardes et les services des modules
(`deps.live.changed`) appellent tous `changed`, et aucun n'a à connaître la
règle. Une sonde qui écrit chez elle rafraîchit ses fenêtres ; un déclenchement
fait depuis une fenêtre rafraîchit le domicile.

Les commandes `share.*` portent leur fonctionnalité en entrée : le dispatcheur
lit le sujet dans la requête et prévient aussi l'espace visé, nécessaire au
retrait, que la table ne relie déjà plus.

Les **compteurs** suivent la même règle que les listes : les cartes de
l'accueil comptent les éléments visibles, projetés compris, restrictions
déduites. Une carte qui compte autre chose que la liste qu'elle ouvre se lit
comme un bug.

## 9. Déplacer, l'exception à L3

`share.movePreview` dit ce qu'un déplacement ferait, `share.move` le fait
(`src/features/sharing/move.ts`). Aucun droit nouveau : qui peut supprimer
l'élément peut le déplacer, dans les deux cas la donnée quitte l'espace, et
supprimer n'a jamais demandé plus que l'écriture.

Deux moitiés, et la frontière est le tout :

- **la fonctionnalité convertit son arbre** (`items.move`, facultatif). Elle
  seule sait quelles cellules sont chiffrées. Sans cette entrée, l'élément ne
  bouge pas : `movable` est faux dans `share.get`, l'écran ne propose rien, le
  serveur refuse. C'est le même contrat que `shareTier` et `items` : le registre
  dit ce que le chiffrement autorise, le module dit ce que le code fait.
- **l'app fait le ménage de ce qui nomme l'espace quitté** : projections,
  surcharges de rôle, route de notification. L'élément arrive **nu**. Les
  projections avaient été accordées par des membres de l'espace d'origine sur
  une donnée qui n'y est plus ; les re-domicilier livrerait une donnée du nouvel
  espace à une audience qu'il n'a pas choisie.

Les deux dans **une transaction** (`ctx.db.transaction`), sans quoi un arbre à
moitié converti serait définitivement illisible, et rien ne pourrait le
détecter : un blob chiffré est indistinguable d'un autre. La conversion lit et
rescelle tout **avant la moindre écriture**, sur le modèle de
`reencryptProjectTree` (Projets).

Les **liaisons ne suivent pas** : un projet relie ce que son espace voit, chez
lui ou projeté, et une liaison vers un élément qui n'y est plus visible est
retirée, l'écran la nommant avant de confirmer. Dans un sens comme dans
l'autre : `PROJECTS_USAGE_PROVIDER.detach` retire celles qui visaient
l'élément parti, chez lui et dans chaque espace qui le recevait, et le `move`
de Projets retire celles qu'un projet emporterait. La même règle vaut hors
déplacement : retirer une projection (`share.set`) ou supprimer l'élément
(`ctx.items.forget`) lâche les liaisons des espaces qui cessent de le voir.

### Qui sait se déplacer, et pourquoi

|                  | Ce que le déplacement emporte                       | Ce qu'il laisse                                   |
| ---------------- | --------------------------------------------------- | ------------------------------------------------- |
| Uptime           | le service, ses relevés, ses incidents              | rien                                              |
| Notes            | la note                                             | son dossier, qui appartient à l'espace quitté     |
| Bases de données | la fiche, ses secrets, ses alertes                  | rien                                              |
| Déploiements     | la cible et son historique                          | son accès : elle arrive indéployable              |
| Git              | le dépôt et tout son cache                          | son jeton : la synchronisation s'arrête           |
| Audience         | le site, ses entonnoirs, ses libellés, son audience | rien (la clé publique ne bouge pas)               |
| Appareils        | la ligne ; relevés et constats la suivent           | les exemptions Sentinelle, réglées par espace     |
| Mail             | le compte, ses dossiers, ses enveloppes             | un canal d'alerte d'ici qui expédiait par lui     |
| Projets          | tout l'arbre                                        | ses liaisons, dont les cibles restent             |
| Hébergement      | le dossier, ses fichiers et ses adresses            | leur domaine : elles reviennent à celle de DevEye |

Un accès ou un jeton mis à `NULL` n'est pas une avarie : les deux features
savent dire « sans accès », et en rattacher un est un geste du propriétaire, pas
un effet de bord d'un déplacement.

**Sauvegardes n'a pas d'entrée `move`, et ce n'est pas un oubli** : un travail ne
peut pas exister sans destination (`destination_id` NOT NULL), et destination
comme source sont des objets de l'espace qu'il quitterait. On ne peut même pas le
laisser sans destination le temps d'en choisir une. **Serveur mail** se partage
sans se déplacer. Mots de passe, CloudSync, Finances et les features sans
éléments ne sont pas concernées. Hébergement se déplace et se partage, mais
**ne se copie pas** : ses fichiers, scellés par une clé du serveur qui ne dépend
d'aucun espace, ne bougent pas quand le dossier change d'espace, et une copie
devrait dupliquer des gigaoctets dans la transaction.

Le refus par élément vit dans `plan` : un nom déjà pris là-bas (Bases, Audience),
un dépôt déjà suivi, une empreinte déjà appairée. Il s'affiche au lieu de tomber
en erreur SQL au milieu du geste.

À l'écran, le geste dure : tout l'arbre est relu et rescellé, et la commande
part avec un délai de deux minutes (`MOVE_TIMEOUT_MS`,
`Components/FeatureSettings/sections/SharingSection.tsx`) au lieu des quinze
secondes ordinaires. Un dialogue de progression que rien ne ferme le dit
(`Components/ProgressDialog`), puis la coquille de réglages se referme et la
fiche s'en va (`onGone`, voir [SETTINGS.md](./SETTINGS.md)) : l'élément n'est
plus ici, il n'y a plus rien à en montrer.

## 10. Copier, le troisième geste

Partager projette, déplacer change de domicile, **copier fait naître un double** :
l'élément reste chez lui, une copie indépendante est écrite ailleurs, et rien ne
relie ensuite les deux. « Ailleurs » est un autre espace d'ici, ou un espace
d'une **instance distante** ([FEDERATION.md](./FEDERATION.md)) : le même chemin
dans les deux cas.

### Deux moitiés qui s'ignorent, le navigateur entre elles

| Moitié          | Commandes                                                                  | Ce qu'elle fait                                                      |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Source**      | `share.copyPlan`, `share.copyExport`, `share.copyChunk`                    | lit l'élément, l'ouvre, le rend **en clair** par tranches            |
| **Destination** | `share.copyTarget`, `share.copyBegin`, `share.copyPut`, `share.copyCommit` | reçoit les tranches, vérifie, scelle sous SA clé, en une transaction |

Le client (`Components/FeatureSettings/copyItem.ts`) lit une tranche à la source
et la remet à la destination, l'une après l'autre : la copie entre deux espaces
d'ici emprunte exactement ce chemin, les deux moitiés sur le même serveur. Il n'y
a donc qu'un code, et la copie entre instances n'est pas un cas à part. La source
ne sait rien de la cible ; les deux serveurs ne se parlent jamais.

Ce qui voyage est **en clair**, par construction : la destination scelle sous une
clé que la source ne connaît pas. Il n'existe que dans la mémoire des deux
serveurs et de l'onglet, trois minutes au plus (`TTL_MS`,
`src/features/sharing/copy.ts`), et la dernière tranche rendue fait oublier le
paquet à la source.

### Rien de ce qui arrive n'est cru

Le paquet vient d'un navigateur, donc de n'importe qui :

- il est **borné** (`MAX_BYTES`, 16 Mo par transfert ; `MAX_BYTES_IN_FLIGHT`,
  un plafond global en vol) et son **empreinte** vérifiée à l'arrivée, avec sa
  taille ;
- sa **version** doit être celle de l'instance, au mineur près (deux versions
  parlent le même contrat quand majeur et mineur coïncident) ;
- ses lignes sont validées par le moteur contre l'arbre du module : les noms de
  table viennent de l'arbre seul, une colonne doit exister dans la table et ne
  pas être de celles que la destination décide (espace, compte, palier, rang,
  colonnes omises), chaque référence doit désigner une ligne du paquet, et toute
  valeur est liée. Un enfant est raccroché à la copie quoi que dise sa ligne.

Droits : **lire** l'élément chez lui pour la source, **écrire** la fonctionnalité
dans l'espace d'arrivée pour la destination, revérifié au moment d'écrire. Les
deux gestes sont audités en `warning` (`share.copyExport`, `share.copy`).

### Un arbre déclaré, un moteur écrit une fois

Un module ne code pas sa copie : il **décrit ce dont un élément est fait**
(`items.copy.tree`, un `ItemTree`), et le moteur du SDK (`src/sdk/copy.ts` de
`@deveye/types` : `exportItemTree`, `importItemTree`) fait le reste pour toutes
les fonctionnalités. Par table : sa clé, la colonne qui la rattache à l'élément,
ses colonnes scellées (`sealed`), ses références vers d'autres tables de l'arbre
(`refs`, réécrites vers les nouveaux ids), la colonne d'espace, celle du compte
(réécrite vers qui copie), et ce que la copie laisse à sa valeur par défaut
(`omit` : une source de l'espace quitté, un état de synchronisation). La racine
dit en plus son rang (`orderColumn`, la copie arrive en fin de liste), ce qui la
rend unique dans un espace (`unique`, le condensé d'un nom) et son palier
(`tier`). Une table `cache: true` est ce que la destination reconstruit seule
(commits, messages relevés, historique de contrôles) : déplacée, jamais copiée.

C'est **la seule liste tenue à la main** : le déplacement en dérive ses cellules
(`movableCellsOf(tree)`), si bien qu'un module tient une liste et non deux. Au
démarrage, `itemTreeProblem` refuse un arbre mal formé, chacun de ses noms
finissant interpolé dans du SQL.

Trois crochets, tous facultatifs (`FeatureItemsCopy`, `src/sdk/server.ts` de
`@deveye/types`) : `plan` (source : ce que la copie n'emporte pas, ce qui
l'empêche), `admit` (destination, avant d'écrire : affirmer un quota, amender
une ligne, comme la clé publique d'un site Audience, régénérée), `settle`
(destination, après).

### Le palier gardé

Un élément chiffré par mot de passe ne se projette ni ne se déplace, mais il se
**copie**. L'export prend le chiffre gardé : coffre fermé, la source répond
`locked`, l'écran rouvre le coffre et rappelle. À l'arrivée, le palier est gardé
si l'espace est personnel (le `locked` de là-bas ouvre l'invite de **ce**
coffre-là, le second mot de passe, `ensureUnlockedOn`), et **ouvert** dans un
espace partagé, qui n'a pas ce palier : la confirmation le dit avant, ses membres
liront la copie.

### Qui se copie

Huit des modules qui se déplacent se copient aussi : Audience, Bases de données,
Déploiements, Git, Mail, Notes, Projets, Uptime. **Pas les Appareils** : un
appareil est une machine reliée par le jeton de son agent, qui ne parle qu'à un
serveur ; il se partage déjà entre espaces. **Pas Hébergement** (§9).

Ce que la copie n'emporte jamais : projections, permissions par rôle, route
d'alertes, liaisons de projets. Une copie arrive nue, comme un élément déplacé,
et pour la même raison : tout cela désigne l'espace d'origine.

Le moteur est couvert par `src/sdk/copy.test.ts` et `src/sdk/move.test.ts` de
`@deveye/types`.

## 11. Limite connue

L'ordonnanceur de fond sonde les éléments **d'un espace**, pas ce qu'on y voit.
C'est voulu : sonder deux fois le même service parce qu'il est projeté ailleurs
doublerait requêtes et incidents.
