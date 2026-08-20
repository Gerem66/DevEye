# Les canaux d'alerte — où partent les notifications

> Écrit le 20 août 2026, à la fin du chantier qui a unifié les réglages de
> fonctionnalité. Il dit **pourquoi** ; le code dit comment.
>
> Documents voisins : [SECURITY_MODEL.md](./SECURITY_MODEL.md),
> [UPTIME.md](./UPTIME.md), [../../WORKSPACES.md](../../WORKSPACES.md).

---

## 1. Le renversement

Cinq fonctionnalités savent prévenir : Uptime, Sentinelle, Bases de données,
Déploiement, Sauvegardes. Jusqu'à ce chantier, chacune portait **deux canaux
binaires** — un mail, un webhook — dans une ligne de `notification_settings`
clé sur `(espace, feature)`.

C'était déjà un progrès : la 075 avait séparé les configurations, parce qu'une
alerte de sécurité arrivant sur le salon de la disponibilité est un message que
personne n'a demandé. Mais la forme gardait trois limites, toutes rencontrées :

1. **Le même salon Discord redéclaré cinq fois.** La 085 le dit sans le dire en
   recopiant la ligne `uptime` dans `database` : la reprise était juste, mais
   elle a produit deux exemplaires d'une même adresse que rien ne relie.
2. **Un seul destinataire par émetteur.** Une équipe pour la production, une
   autre pour la recette : il fallait choisir.
3. **Aucun routage par élément.** Toutes les bases d'un espace prévenaient les
   mêmes gens, quel que soit le projet derrière.

Un canal est donc devenu une **entité de l'espace**. Une fonctionnalité — ou un
de ses éléments — n'en garde qu'une **liaison**.

C'est la même forme que celle des dépôts git, des bases, des sites et des cibles
de déploiement : des objets d'espace, pas des propriétés d'une feature.

---

## 2. Les trois tables, et pourquoi trois

| Table | Ce qu'elle porte |
|---|---|
| `notification_channels` | les destinations : type, libellé, cible, compte expéditeur |
| `notification_routes` | une cible de routage : `(espace, feature, item_id)` |
| `notification_route_channels` | quels canaux cette route sert |

La liaison est séparée pour **une** raison, et elle est structurante : la
*présence* d'une ligne `notification_routes` pour un élément vaut « réglé à la
main », son *absence* vaut « hérite de sa fonctionnalité ». Une route existante
sans aucune liaison exprime donc **le silence**, ce qu'un tableau d'identifiants
rangé dans une colonne ne saurait pas distinguer de « pas encore réglé ».

`item_id = 0` désigne la fonctionnalité elle-même : une colonne d'une clé unique
ne peut pas être nulle. Le contrat, lui, rend simplement `itemId` absent — la
sentinelle est une contrainte de stockage, elle n'a pas à remonter.

### La règle de résolution, dans l'ordre

1. l'élément a une route → **ses** canaux, silence compris ;
2. sinon → la route de sa fonctionnalité ;
3. sinon → aucun canal.

Rien n'est deviné. Sans route enregistrée, rien ne part — c'est le défaut qui
compte, et celui que la 075 avait déjà posé.

---

## 3. Les trois types de canal

```
email    un compte Mail « open » de l'espace expédie vers une adresse
webhook  un POST JSON générique : `content` (Discord), `text` (Slack),
         plus les champs structurés pour un point d'entrée maison
discord  la mise en page riche (embeds, couleurs, champs) et, pour le
         déploiement, le suivi vivant — un message qui se met à jour
```

### Discord n'est plus deviné

`webhookBody` reniflait l'URL pour choisir entre embeds et texte. Ça marchait,
et le commentaire de `discord.ts` le reconnaissait déjà comme un pis-aller :
ça **décidait à la place de l'utilisateur**. Un point d'entrée maison servi
depuis un domaine Discord recevait des embeds au lieu de son texte, et rien ne
permettait de demander l'inverse.

C'est désormais une déclaration. `isDiscordWebhook` survit, mais comme
**contrôle de saisie** : l'écran avertit qu'une URL déclarée Discord n'en est
pas une, sans refuser.

### Les cinq émetteurs ont leur mise en page

`Services/notices/` : `shared.ts` (couleurs, `moment`, `duration`, `trim`,
`block`) puis un module par émetteur. Seuls `deploy` et `uptime` en avaient ;
les trois autres envoyaient du texte brut faute que le module ait été écrit.

Le socle commun n'est pas de la cosmétique : les deux jeux de helpers avaient
**dérivé**. `duration()` traitait les jours côté Uptime et s'arrêtait aux heures
côté Déploiement, si bien qu'une panne de trois jours se lisait « 72 h » d'un
côté et « 3 j » de l'autre.

### Le suivi vivant, désormais multi-canal

`deployments.content.noticeId` était **une** chaîne. Avec plusieurs canaux
Discord il faut une carte `identifiant de canal → identifiant de message` :
les confondre ferait éditer, dans le second salon, un identifiant qui appartient
au premier. D'où `noticeIds`.

Les canaux d'un même déploiement sont publiés **séquentiellement**, jamais en
`Promise.all` : ils écrivent tous dans le même blob, et les lancer de front en
perdrait. Le parallélisme reste sur les déploiements, où est la latence.

---

## 4. Chiffrement

Tout est à l'**étage ouvert** (`ctx.secure.open`) : ce sont les boucles de fond
qui relisent les canaux, sans session ni mot de passe. Un secret rangé au palier
gardé y serait illisible et l'alerte ne partirait jamais, en silence.

`label_enc` est **nullable**, et c'est l'état dans lequel la reprise de la 087
laisse les canaux qu'elle crée : aucune requête SQL ne peut produire un
cryptogramme, et y écrire du clair rendrait `tryDecrypt` nul à la lecture. Le
serveur retombe alors sur la **destination** elle-même — la meilleure
description possible d'un canal que personne n'a nommé, et ce qui donne à voir
les doublons de la reprise comme des doublons.

---

## 5. Autorisation : deux étages, et ils ne se confondent pas

| | Qui |
|---|---|
| Déclarer, corriger, supprimer un canal | capacité `workspace.notifications` |
| Lire la **liste** des canaux | tout membre |
| Lire la **destination** d'un canal | capacité `workspace.notifications` |
| Router une fonctionnalité vers un canal | `<feature>: write` |

La liste est ouverte parce qu'**on ne peut pas router vers des destinations
qu'on ne voit pas**. Leur contenu ne l'est pas : confier le réglage d'Uptime ne
confie pas l'adresse de l'astreinte ni l'URL du salon de production. On voit
donc « Astreinte · e-mail », on peut y router, on ne peut ni la lire ni la
modifier — `describeChannel` vide `target` pour qui n'a pas la capacité.

`notify.routeGet` / `routeSet` sont les **seules** commandes du dépôt dont
l'autorisation ne peut pas être déclarative : la fonctionnalité visée est une
donnée d'entrée, pas une constante de la commande. Le contrôle est donc en
première ligne de handler, comme pour `device.setConfig`, et pour la même raison.

---

## 6. Côté client

`Components/FeatureSettings/` — **une seule coquille pour les deux échelles**
(une fonctionnalité, un de ses éléments), navigation à gauche, sections à
droite. Elle remplace `Components/NotificationsDialog`, elle-même née de la
fusion de cinq copies dont l'une avait perdu en chemin l'avertissement « aucun
compte expéditeur valide ».

Le principe qui la gouverne : **une section n'apparaît que si elle mène à
quelque chose d'utilisable, et quand il n'en reste aucune, le bouton n'existe
pas**. `FeatureSettingsButton` rend `null` — la règle tient à un seul endroit
plutôt que d'être à retenir dans chaque feature.

Points d'appel : la barre d'outils de chaque émetteur (échelle fonctionnalité)
et l'en-tête de fiche d'un service, d'une base, d'une cible, d'un travail
(échelle élément).

**La gestion des canaux ne se rend qu'à l'échelle de la fonctionnalité.** À
l'échelle d'un élément, la section ne fait que choisir (héritage et cases), et
« Gérer les canaux » ouvre les réglages de la fonctionnalité par-dessus, sur ce
même onglet. C'est le contrat des sources (`Docs/SOURCES.md`) : une chose
réutilisable se crée et se corrige à un seul endroit, les éléments la désignent.
Avant cette coupe, le formulaire d'ajout se rendait aux deux échelles : chaque
écran d'élément était une porte de plus vers la même liste.

---

## 7. Reprise de l'existant (migration 087)

À l'identique, comme la 075 et la 085 : personne ne perd au redémarrage une
alerte qu'il recevait la veille. Deux limites assumées :

- **Les doublons ne peuvent pas être fusionnés en SQL.** Le chiffrement est non
  déterministe : deux lignes portant la même URL ont deux cryptogrammes
  différents. Un espace qui avait réglé le même salon sur cinq émetteurs obtient
  cinq lignes. « Utilisé par N » les rend visibles, la suppression prend deux
  clics.
- **Tout webhook entre en `webhook`, jamais en `discord`.** Le SQL ne peut pas
  lire l'URL. L'écran le reconnaît à l'affichage et propose la bascule ; jusque
  là le comportement est exactement celui d'avant.

### Deux pièges rencontrés, et ce qu'ils ont coûté

- **Collation.** Déclarer `utf8mb4_general_ci` sur les tables créées ne suffit
  pas : la connexion de MySQL 8 parle `utf8mb4_0900_ai_ci`, et un
  `r.feature = s.feature` entre deux **colonnes** de collations différentes
  échoue en « Illegal mix of collations » — là où une comparaison à un littéral
  passe. Mesuré sur base de contrôle : la migration s'arrêtait à la première
  insertion. La 080 documentait déjà ce piège ; il s'est reproduit à
  l'identique. Les rangs passent donc par un `CASE` sur littéraux, et la seule
  comparaison colonne-à-colonne porte un `COLLATE` explicite.
- **Rejouabilité.** Le fichier se termine par un `DROP TABLE`. Écrit
  naïvement, un second passage échouait sur « Table doesn't exist » — et comme
  `migrate.ts` n'enregistre le nom qu'après succès, une interruption en fin de
  fichier aurait **bloqué définitivement le démarrage**. Les cinq instructions
  de reprise passent donc par `INFORMATION_SCHEMA` + `PREPARE`/`EXECUTE`.
  Vérifié : trois passages consécutifs, comptes identiques.

### Le rattachement passe par `position`

On ne peut pas rapprocher un canal de sa ligne d'origine par son contenu : la
085 a recopié `email_enc` et `webhook_enc` **octet pour octet** d'`uptime` vers
`database`, si bien que deux features d'un même espace portent des cryptogrammes
identiques. Un rapprochement par valeur produirait un produit croisé — les deux
canaux liés aux deux routes. `position` porte donc une place déterministe,
`rang de la feature × 2 + (0 mail, 1 webhook)`.

---

## 8. Ajouter un émetteur

1. une valeur dans `notificationFeatureSchema` (`DevEye-Types/src/domain/notifications.ts`) ;
2. `notifies: true` dans `FEATURE_REGISTRY` — le contrôle au chargement du
   module refuse le démarrage si les deux divergent ;
3. un module dans `Services/notices/` s'il mérite une mise en page Discord ;
4. l'appel à `resolveRoute(db, cipher, workspaceId, feature, itemId?)` puis
   `deliver(...)` dans son service de fond ;
5. s'il a des éléments : `ctx.db.notificationChannels.clearRoute(...)` dans son
   handler de suppression, à côté d'`itemSharing.forgetItem`. Rien ne rattache
   une route à son élément (pas de FK : la cible change de table selon la
   feature), et une route orpheline vaut « réglé à la main » : le prochain
   élément à hériter de l'identifiant adopterait le routage du mort. La 090 a
   résorbé les orphelines accumulées avant ce câblage.

Aucune commande, aucun handler, aucun écran : c'était trois commandes et trois
handlers avant ce chantier.

## 9. Un seul interrupteur par cible (migration 090)

Uptime a longtemps porté **deux** interrupteurs : sa route, et une case
« M'alerter » par service, d'avant la 087, rendue dans un autre dialogue. Une
route parfaitement réglée pouvait rester muette à cause d'une case que rien ne
signalait. La 090 a fait entrer la case dans la sémantique des routes (un
service silencieux est devenu une route explicite sans canal), puis a supprimé
la colonne. La règle vaut pour tout émetteur : **la route est le seul endroit
qui décide**, et `deliver` sans canal rend `false`, ce qui suffit à retenir le
« c'est revenu » d'une panne jamais annoncée.
