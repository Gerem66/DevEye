# Bases de données — l'inventaire d'un espace

Feature de premier rang, bâtie sur le même patron que [GIT.md](GIT.md) : une base
appartient à **l'espace**, plusieurs projets peuvent s'en servir, et certaines ne
servent aucun projet. Un projet ne fait qu'y **pointer**.

Relu et mis à jour le 21 août 2026 (canaux et sélection par élément).
Documents voisins à respecter : [WORKSPACES.md](WORKSPACES.md), [LIVE.md](LIVE.md),
[GIT.md](GIT.md), [PROJECTS.md](PROJECTS.md), [AUDIENCE.md](AUDIENCE.md).

---

## 1. Le principe : à la demande

**Rien ne se connecte tout seul.** Ouvrir la feature ne joint aucun serveur ;
la liste et la fiche lisent le dernier relevé enregistré. Cinq commandes
seulement sortent vers un serveur tiers, et toutes sur un geste explicite :

| Commande | Ce qu'elle fait |
|---|---|
| `database.test` | un essai de connexion, rien d'autre |
| `database.testDraft` | le même essai, sur des réglages **pas encore enregistrés** |
| `database.inspect` | un relevé complet (version, taille, tables) **et** les alertes |
| `database.tableList` | les tables, avec leur taille et leur nombre de lignes |
| `database.tableStructure` | colonnes, clé primaire, clés étrangères, index |
| `database.tableRows` | une page du contenu, filtres et tri compris |
| `database.rowInsert` / `rowUpdate` / `rowDelete` | l'écriture d'une ligne |
| `database.execute` | une instruction libre — le terminal |
| `database.export` | une table, ou la base, en CSV / JSON / SQL |
| `database.query` / `alertTest` | une requête de lecture, pour mettre au point une condition |

Une seule exception à « rien ne part sans clic » : `autoLoadTables`, réglage
**par base et éteint par défaut**, charge l'inventaire des tables à l'ouverture
de la fiche. Il vit dans le blob chiffré `content` et non dans une colonne — un
réglage d'affichage n'entre dans aucune requête et ne se trie sur rien, donc
aucune migration.

Le **relevé périodique** existe, mais il est **éteint par défaut et s'active base
par base** (`monitor_enabled`). C'est la différence de fond avec Uptime, qui
surveille tout ce qu'on lui confie : ici, une base au repos ne coûte rien et ne
réveille personne.

> ⚠️ Corollaire à connaître, et que l'interface répète à trois endroits : **une
> alerte n'est évaluée que si le relevé est actif sur sa base.** Une alerte posée
> sur une base au repos est inerte.

### Tester et relever ne parlent pas au même endroit

Les deux joignent le serveur, et c'est bien pourquoi il fallait les séparer à
l'écran :

- **Tester** n'écrit rien. Son résultat n'a donc **aucun autre endroit où
  s'afficher** qu'une phrase — d'où `ProbeLine`, qui dit « connexion en cours »
  pendant l'essai puis affiche l'issue, et **l'efface au bout de dix secondes**.
  Un « est-ce que ça répond ? » répond pour l'instant où on l'a posé ; laissé à
  l'écran, il se lirait une heure plus tard comme un état courant.
- **Relever** écrit. Son résultat *est* le bandeau « État / Temps de réponse /
  Dernier relevé / Taille / Tables / Version » — il n'a donc pas de phrase du
  tout. Il en affichait une jusqu'au 2026-08-09, qui doublait mot pour mot ce que
  le bandeau disait déjà juste en dessous.

`last_elapsed_ms` (migration 070) est la durée du dernier relevé, **renseignée
aussi sur un échec** : un relevé qui met douze secondes à tomber dit qu'on a
attendu un délai d'attente, pas qu'on s'est fait refuser tout de suite. C'est le
premier signe d'une base qui se dégrade, bien avant qu'elle devienne
injoignable.

---

## 2. Les invariants

### 2.1 Toujours à l'étage ouvert

Une base est d'espace et peut servir des projets de paliers différents ; elle ne
peut donc suivre aucun d'eux. Tout — réglages, secrets, alertes — est chiffré
sous la clé de l'espace. Conséquences assumées :

- rien ici ne demande jamais de mot de passe ;
- le relevé périodique lit tout sans session, ce qui est exactement ce dont il a
  besoin ;
- **un projet confidentiel ne peut pas lier de base**, et passer un projet en
  confidentiel délie les siennes (les bases, elles, survivent).

### 2.2 Aucun secret ne redescend

Deux secrets par base, chacun dans sa colonne et jamais dans `content` : le mot
de passe de la base, et celui du tunnel (mot de passe SSH ou clé privée). Les
DTO n'en portent qu'un booléen (`hasPassword`, `access.hasSecret`).

Corollaire sur les formulaires : un champ laissé intact **conserve** le secret en
place ; une chaîne vide l'efface. Le client ne peut pas renvoyer un secret
inchangé, puisqu'il ne l'a jamais reçu.

> ⚠️ **Quatre colonnes chiffrées par base**, toutes déclarées dans
> `workspaceRekey` (`content`, `secret_enc`, `access_content`,
> `access_secret_enc`) plus `database_alerts.content`. En oublier une la rendrait
> illisible après une conversion de clé d'espace, **sans rien pour le signaler** :
> au mieux l'hôte disparaît de l'écran, au pire le mot de passe devient un octet
> mort et la base injoignable sans qu'on sache pourquoi.

### 2.3 Ce qui doit être unique ne peut pas être chiffré

Le nom porte l'unicité dans l'espace, via `name_ref` (16 caractères du sha256 du
nom en minuscules). Même motif que `slug_ref` pour un dépôt git, et pour la même
raison : le chiffrement n'étant pas déterministe, `content` ne peut porter
aucune contrainte d'unicité.

### 2.4 La table s'appelle `database_connections`

`databases` est un **mot réservé** de MySQL : `CREATE TABLE databases` échoue à
l'analyse. Le contourner à coups de guillemets obliques dans chaque requête
reviendrait à confier la correction à la vigilance ; un nom libre la rend
inutile.

---

## 3. Les alertes

Une alerte, c'est **des conditions, un opérateur, un message**.

- Une **condition** est une requête qui rend **un seul nombre** — une ligne, une
  colonne — comparée à un seuil. Cette contrainte est ce qui rend le reste
  possible : un nombre se compare, se raconte dans un message et se relit dans
  l'historique.
- Les conditions se combinent en **ET** ou en **OU**.
- Le message accepte `{nom court}`, remplacé par la valeur mesurée de la
  condition portant ce nom : « déjà {erreurs} erreurs cette heure-ci ».

Trois décisions qui méritent d'être connues :

1. **Une condition qui échoue ne franchit pas.** En `and` elle empêche le
   déclenchement, en `or` elle ne l'entraîne pas. Le contraire ferait d'une
   requête mal écrite une source d'alertes permanentes, ce qui est la meilleure
   façon de faire ignorer un canal d'alerte.
2. **Une condition en échec n'interrompt pas les autres.** On veut voir d'un
   coup d'œil laquelle des cinq est mal écrite.
3. **On notifie aux transitions, dans les deux sens**, jamais à chaque relevé.
   `database_alerts.firing` porte l'état courant ; sans lui, une base qui dépasse
   son seuil la nuit enverrait un message toutes les cinq minutes.

Les **canaux sont les siens** depuis la migration `085`. Ils ne l'ont pas toujours
été : `DatabaseMonitor` appelait `UptimeMonitor.resolveChannels`, au motif que
c'étaient « mêmes destinataires, une seule configuration à tenir à jour ». C'est
mot pour mot le raisonnement que Sentinelle avait suivi avant la `075`, et il a
produit le même effet — un seuil SQL franchi arrivait sur le salon désigné pour
la disponibilité, sans qu'on puisse l'éteindre sans éteindre Uptime, ni le
router ailleurs, ni rien lire à l'écran qui dise où il partait.

La reprise a été faite **à l'identique** : la migration recopie la ligne `uptime`
dans `database`, donc personne n'a perdu au redémarrage une alerte qu'il recevait
la veille. Le modèle a encore bougé depuis : les canaux appartiennent à la
feature (091) et se gèrent dans **Réglages → Notifications** de la coquille
commune, et c'est **chaque base** qui coche les siens dans ses propres réglages
(092), sans héritage depuis la feature : une base sans canal coché ne prévient
personne. Le mécanisme d'envoi, lui, est celui commun aux émetteurs
(`Services/notifications.ts`) : `DatabaseMonitor` en gardait une copie mot pour
mot, alors que ce module existait précisément pour l'éviter. Voir
`NOTIFICATIONS.md`.

Le bouton **« Essayer maintenant »** du dialogue d'alerte est le cœur de cet
écran, pas un extra : il évalue les conditions telles qu'on vient de les écrire,
sans rien enregistrer ni notifier. Sans lui, on choisirait un seuil à l'aveugle
et l'on découvrirait son erreur par une notification, la nuit.

---

## 4. Les tunnels

Trois chemins, décrits par `access.kind` :

| Chemin | Quand |
|---|---|
| `direct` | le serveur joint l'hôte lui-même |
| `ssh` | on a un compte sur une machine du réseau (rebond) |
| `socks` | un VPN est déjà monté ailleurs et expose un proxy SOCKS5 |

**Un écouteur local, pas une socket passée au pilote.** `mysql2` accepte une
socket existante, `pg` non — il veut ouvrir la sienne vers un hôte et un port. Un
petit écouteur sur `127.0.0.1:0` donne aux deux pilotes ce qu'ils savent
consommer, sans rien supposer de leur implémentation. `127.0.0.1` et non
`0.0.0.0` : ce relais n'a aucune raison d'être joignable de l'extérieur, et
l'exposer ouvrirait un accès à la base sans authentification.

La clé privée reste **en mémoire** : jamais de fichier temporaire, qui
survivrait à un arrêt brutal.

**Un tunnel est toujours rendu avec son `close()`, et l'appelant le ferme dans un
`finally`** — y compris quand la session échoue à s'ouvrir *après* le tunnel.
Sur un relevé périodique, quelques heures d'écouteurs oubliés suffiraient à
épuiser le processus.

---

## 5. Écrire sans ouvrir de porte

L'explorateur administre : il ajoute, modifie et supprime des lignes, et son
terminal accepte n'importe quelle instruction. Ce qui protège cet ensemble tient
en trois règles, et aucune n'est un nettoyage de chaîne.

### 5.1 Un identifiant se confronte, il ne se nettoie pas

Un nom de table ou de colonne **ne peut pas être un paramètre lié** : il faut
bien l'écrire dans le texte de la requête. La parade n'est pas de le filtrer mais
de ne jamais utiliser celui qu'on a reçu : `resolveTable` et `resolveColumns`
(`features/database/explore.ts`) le cherchent dans le catalogue réel et rendent
**celui du serveur**. Un nom absent n'atteint donc aucune requête.

C'est le seul fichier du module qui nomme des identifiants venus du client, et
c'est pourquoi la vérification y est concentrée.

### 5.2 Une valeur reste une valeur

Toujours liée, jamais recollée. L'opérateur d'un filtre est choisi dans une
énumération fermée du contrat (`databaseFilterOperatorSchema`), pas écrit par
l'appelant : il n'existe aucun chemin par lequel une saisie devienne du code.

Les jokers d'un `LIKE` sont en revanche **rendus tels quels** : `%` remplace
n'importe quelle suite, `_` un caractère, `\%` un pourcentage littéral. La
recherche est une grille sur du vrai SQL, et pouvoir écrire `2026-%-01` vaut
mieux que de n'avoir aucun moyen d'exprimer un motif. Rien n'en devient
dangereux : la valeur reste liée, seul son *sens* pour `LIKE` change. Les deux
moteurs prennent `\` comme caractère d'échappement par défaut, la convention est
donc la même des deux côtés. C'était l'inverse jusqu'au 2026-08-09, avec une
phrase d'écran pour l'expliquer — une phrase qui prévient d'un comportement
inattendu est le signe qu'on a pris une liberté de trop.

### 5.3 Deux gardes d'instruction, deux intentions

1. `assertReadOnly` refuse tout ce qui n'est pas un `SELECT`/`WITH`/`SHOW`/
   `EXPLAIN` **unique**. Elle sert aux **conditions d'alerte** : une surveillance
   n'a pas à écrire.
2. `assertSingleStatement` accepte les écritures mais refuse la **salve**. Elle
   sert au **terminal** : refuser un `UPDATE` là où l'explorateur en propose par
   formulaire n'aurait aucun sens, mais un copier-coller de trois instructions
   dont on ne visait que la première s'exécuterait en entier sans qu'aucun écran
   n'ait montré les deux autres.

Et par-dessus tout : le **compte** saisi dans les réglages décide en dernier
ressort. DevEye demande, le serveur distant accorde ou refuse.

### 5.4 Sans clé primaire, pas d'écriture

`primaryKey` vide interdit modification et suppression, côté serveur comme dans
l'interface. Sans clé, aucune condition ne désigne *une* ligne : un `UPDATE` en
toucherait plusieurs, un `DELETE` en emporterait autant, et rien ne permettrait
de revenir en arrière. Mieux vaut ne pas savoir faire que faire trop.

### 5.5 Suivre une clé étrangère

Cliquer une cellule contrainte ouvre la table visée **filtrée sur la valeur
pointée**, et auréole la ligne quelques secondes. Filtrer plutôt que calculer la
page où elle se trouve : ce calcul supposerait un ordre stable et une clé d'une
seule colonne, deux hypothèses que rien ne garantit. Le critère reste visible et
se retire d'un clic — on voit donc *pourquoi* on ne voit qu'une ligne.

### 5.6 Un export lit tout ce qu'on lui désigne

Il portait jusqu'au 2026-08-09 un bandeau d'avertissement et un plafond de 20 000
lignes / 6 Mo. Un export qui s'arrête au milieu n'est pas un export, et prévenir
n'y changeait rien : le plafond est devenu un **garde-fou mémoire** du serveur
(5 000 000 lignes, 64 Mo), placé là où un export réel n'arrive pas — le contenu
se construit en mémoire avant de traverser la connexion en un morceau. S'il est
touché, `truncated` le dit toujours, sans détour.

À la place du bandeau, l'écran affiche une **estimation de taille** en pied, à
côté du bouton : elle répond à la seule question qu'on se pose avant de cliquer,
et elle suit la portée choisie. Elle est tirée de la taille déclarée par le
moteur (index compris), donc c'est un ordre de grandeur — et l'écran écrit
« ≈ ».

`idRanges` restreint l'export aux lignes dont la clé primaire tombe dans l'une
des plages. Réservé à **une** table, et à une clé d'une seule colonne : d'une
table à l'autre, « 1 à 500 » ne désignerait pas les mêmes objets, et sur une clé
composite, rien du tout. La saisie (« 1-500, 812, 2000- ») est analysée dans le
navigateur ; le contrat ne transporte que des paires de nombres, liées comme
toute autre valeur.

---

## 6. Carte du code

### Contrats — `DevEye-Types/src/`

```
domain/database.ts     schémas, lignes SQL, bornes de longueur
features/database.ts   25 commandes, préfixe unique `database.`
features/project.ts    project.databaseList / databaseLink / databaseUnlink
```

### Serveur — `DevEye/src/`

```
db/migrations/068_databases.sql   database_connections, database_alerts,
                                  project_database_links
db/migrations/070_…_time.sql      last_elapsed_ms : la durée du dernier relevé
db/repos/database.ts              lectures enrichies, alertes, liaisons
Services/databases/tunnel.ts      SSH (ssh2) et SOCKS5 (socks)
Services/databases/engine.ts      adaptateurs MySQL et PostgreSQL
Services/DatabaseMonitor.ts       relevé périodique + évaluation + notification
Services/notifications.ts         résolution des canaux et livraison, communes aux 4 émetteurs
features/database/notifications.ts  les 3 commandes de réglage des canaux
db/migrations/085_deploy_sync_notifications.sql  la ligne `database`, reprise d'Uptime
features/database/                crud.ts · probe.ts · explore.ts · alerts.ts
features/project/databaseLink.ts  le pointeur d'un projet
```

### Client — `DevEye/client/src/Features/Database/`

```
index.tsx           liste + détail ; possède le niveau live `l1`
DatabaseList.tsx    les cartes + le glisser-déposer (src/dragReorder.ts)
DatabaseDetail.tsx  état, alertes, explorateur, projets liés
DatabaseView.tsx    le contenu partagé avec l'onglet d'un projet
DatabaseDialog.tsx  onglets Paramètres / Options : connexion, tunnel, surveillance
ProbeLine.tsx       « en cours », puis le résultat d'un essai, effacé après 10 s
AlertDialog.tsx     conditions, opérateur, message, essai à blanc
TableExplorer.tsx   tables, contenu, sélection, tri, clés étrangères, plein écran
Pagination.tsx      Précédent / Suivant + les numéros, avec coupures
ResultTable.tsx     le tableau d'un jeu de résultats, et sa vue en grand
RowDialog.tsx       ajout / modification d'une ligne, NULL explicite, colonnes auto
StructureDialog.tsx colonnes, contraintes, index, copie mise en forme
SearchDialog.tsx    critères colonne / opérateur / valeur
TerminalDialog.tsx  instruction libre, aperçus cliquables, confirmation des écritures
ExportDialog.tsx    portée, format, plages d'identifiants, estimation de taille
rowKey.ts           ce qui identifie une ligne — la clé, jamais l'indice
format.ts  DatabaseWidget.tsx  style.module.css
```

Deux composants de cette liste servent **deux écrans chacun**, et c'est
volontaire : `ProbeLine` porte le retour d'un essai dans la fiche comme dans le
pied de la popup de réglages (les deux doivent dire la même chose et s'effacer
pareil), et `ResultTable` rend l'aperçu du terminal comme sa vue en grand — une
ligne vue en petit est ainsi forcément la même que celle vue en grand.

`Features/Projects/Database/Databases.tsx` est l'onglet d'un projet : une
enveloppe mince sur `project.databaseList` / `databaseLink` / `databaseUnlink`.
Il **n'apparaît qu'à partir de la première base reliée** ; sans liaison, il
repart dans le menu « + » de la barre d'onglets, qui rouvre le même dialogue
d'ajout — voir [PROJECTS.md](./PROJECTS.md) §2.

---

## 7. Pièges

### Le filet de démarrage ne voit qu'une partie du module

`MUTATION_VERB` cherche un verbe **juste après le point**. Il attrape donc
`database.add`, `database.update`, `database.remove`, `database.reorder` — mais
**pas** `database.alertAdd`, `alertUpdate`, `alertRemove`, ni
`project.databaseLink`. Leurs `mutates` se relisent à la main.

### Un relevé manuel et un relevé automatique suivent le même chemin

`database.inspect` appelle `DatabaseMonitor.checkNow`, exactement comme
l'ordonnanceur. Deux implémentations auraient divergé au premier ajustement, et
c'est le genre de divergence qui ne se voit qu'en production — « ça marche quand
je clique, mais pas la nuit ».

### `unknown` n'est pas `down`

L'état par défaut d'une base est « jamais testée », pas « en panne ». Le peindre
en rouge ferait passer un inventaire au repos pour un incident. Trois tons, et le
neutre est le défaut assumé.

### La version connue survit à une coupure

Un relevé qui échoue conserve la version, la taille et le nombre de tables
précédents : ils décrivent la dernière fois où l'on a pu regarder, ce qui vaut
mieux qu'un écran vide pendant une panne.

---

## 8. Vérification

```bash
# Migrations, sur une copie du dump — elles tournent au boot, hors transaction
mysql … -e "DROP DATABASE IF EXISTS DevEye_migtest; CREATE DATABASE DevEye_migtest"
mysql … DevEye_migtest < Backups/<dump>.sql
DB_DATABASE=DevEye_migtest LISTEN_PORT=3099 npx tsx index.ts   # ×2

rsync -a --delete DevEye-Types/src/ DevEye/node_modules/deveye-types/src/
diff -rq DevEye-Types/src DevEye/node_modules/deveye-types/src   # doit être vide
./ci.sh
```

**Au démarrage** : zéro avertissement `mutates`, aucun « préfixe de commande
inconnu ».

**Vérifié contre un vrai serveur MySQL 8.0**, sur des bases jetables créées et
détruites pour l'occasion — jamais sur les tables de DevEye :

- *le socle* — inventaire, liste des tables, pagination, requête libre, les
  quatre messages d'erreur de connexion, l'évaluation des conditions (y compris
  une condition cassée qui n'interrompt pas les autres), l'interpolation du
  message, le chemin nominal d'un **tunnel SOCKS5** (proxy d'essai monté pour
  l'occasion, avec contrôle qu'aucun écouteur ne reste ouvert), et `testDraft` ;
- *l'explorateur* (33 cas) — structure lue au complet (ordre des colonnes, clé
  primaire, auto-incrément, défaut, commentaire, index unique ou non, clé
  étrangère et sa cible, table sans clé), insertion, modification par clé,
  suppression multiple, recherche `contient` / `est nul` / deux critères en OU
  avec tri, **le `%` saisi cherché littéralement**, une valeur d'injection qui
  reste une valeur, le refus du serveur sur une clé étrangère orpheline et sur
  la suppression d'un parent référencé, le terminal en lecture et en écriture ;
- *l'export* (18 cas) — les trois formats sur des valeurs piégeuses (guillemet,
  apostrophe, virgule, `NULL`, accents), JSON qui reste **un document valide**
  y compris sur une base entière avec une table vide, pagination par 3 sur 12
  lignes sans perte ni doublon, les deux plafonds atteints et signalés, et une
  table inconnue qui n'atteint jamais le moteur.

**Vérifié hors serveur**, sur les fonctions découpées dans les fichiers livrés
plutôt que recopiées :

- *la fabrication des requêtes* (32 cas) — citation d'un identifiant hostile,
  valeur qui reste liée, numérotation PostgreSQL qui se poursuit au-delà du
  `WHERE`, jokers d'un `LIKE` transmis tels quels, `IS NULL` plutôt que `= NULL`,
  appariement d'une clé composite, regroupement des index, les deux gardes
  d'instruction ;
- *les gardes d'écriture* (13 cas) — colonne inconnue refusée, clé composite
  acceptée dans le désordre mais refusée si incomplète, une colonne quelconque
  qui ne fait pas une clé, et le refus global sur une table sans clé primaire.

**Au démarrage**, sur une base vierge : les 133 migrations passent, zéro
avertissement, zéro erreur, aucun « préfixe de commande inconnu » — les huit
commandes nouvelles franchissent donc le filet.

**Non vérifié faute d'instance** :

- le chemin nominal de **PostgreSQL** — seuls ses chemins d'erreur l'ont été. Ses
  requêtes de catalogue (`pg_attribute`, `unnest(conkey, confkey) WITH
  ORDINALITY`) sont écrites avec soin mais n'ont jamais tourné : c'est à essayer
  en premier ;
- le chemin nominal du **rebond SSH** ;
- **l'interface**, qu'aucun navigateur n'a affichée : disposition de la barre
  d'outils, halo d'une ligne rejointe, popups. Tout ce qui précède est du
  comportement, pas du rendu.
