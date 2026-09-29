# Bases de données — l'inventaire d'un espace

Feature de premier rang, bâtie sur le même patron que [Git](../git/README.md) : une base
appartient à **l'espace**, plusieurs projets peuvent s'en servir, et certaines ne
servent aucun projet. Un projet ne fait qu'y **pointer**.

Module in-repo (`features/database`, neuvième native rapatriée sur le SDK des
features, 28 août 2026) : contrats dans `src/contracts/`, relevé, moteur et
handlers dans `src/server/`, écrans dans `src/client/`. L'app ne garde que
l'identité (`database` dans le registre publié), les deux contrats que le
module publie ou consomme (`sdk/providers.ts`) et la table de liaison de
Projets. Voir [Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md), section « La migration des
natives ».

Relu et mis à jour le 28 août 2026 (rapatriement en module).
Documents voisins à respecter : [Docs/WORKSPACES.md](../../Docs/WORKSPACES.md), [Docs/LIVE.md](../../Docs/LIVE.md),
[Git](../git/README.md), [Projets](../projects/README.md), [Audience](../audience/README.md),
[Sauvegardes](../backup/README.md).

---

## 1. Le principe : à la demande

**Rien ne se connecte tout seul.** Ouvrir la feature ne joint aucun serveur ;
la liste et la fiche lisent le dernier relevé enregistré. Cinq commandes
seulement sortent vers un serveur tiers, et toutes sur un geste explicite :

| Commande                                         | Ce qu'elle fait                                                |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `database.test`                                  | un essai de connexion, rien d'autre                            |
| `database.testDraft`                             | le même essai, sur des réglages **pas encore enregistrés**     |
| `database.inspect`                               | un relevé complet (version, taille, tables) **et** les alertes |
| `database.tableList`                             | les tables, avec leur taille et leur nombre de lignes          |
| `database.tableStructure`                        | colonnes, clé primaire, clés étrangères, index                 |
| `database.tableRows`                             | une page du contenu, filtres et tri compris                    |
| `database.rowInsert` / `rowUpdate` / `rowDelete` | l'écriture d'une ligne                                         |
| `database.execute`                               | une instruction libre — le terminal                            |
| `database.export`                                | une table, ou la base, en CSV / JSON / SQL                     |
| `database.query` / `alertTest`                   | une requête de lecture, pour mettre au point une condition     |

Une seule exception à « rien ne part sans clic » : `autoLoadTables`, réglage
**par base et éteint par défaut**, charge l'inventaire des tables à l'ouverture
de la fiche. Il vit dans le blob chiffré `content` et non dans une colonne — un
réglage d'affichage n'entre dans aucune requête et ne se trie sur rien, donc
aucune migration. Il se règle, comme le relevé et sa cadence, dans le panneau
**Général** de la base (Réglages de l'élément, coquille commune).

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
- **Relever** écrit. Son résultat _est_ le bandeau « État / Temps de réponse /
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
sous la clé de l'espace (`ctx.cipher()` dans les handlers, `deps.cipherFor(ws)`
dans le service : l'étage ouvert du SDK, l'ex `secure.open`). Conséquences
assumées :

- rien ici ne demande jamais de mot de passe ;
- le relevé périodique lit tout sans session, ce qui est exactement ce dont il a
  besoin ;
- **un projet confidentiel ne peut pas lier de base**, et passer un projet en
  confidentiel délie les siennes (les bases, elles, survivent).

Une base **projetée** vers un autre espace (`shareTier: 'open'`, voir
[Docs/SHARING.md](../../Docs/SHARING.md)) reste chiffrée chez elle : les listages choisissent
le codec ligne par ligne (`ctx.sharing.scope().cipherFor`), la fiche et les
alertes se lisent sous la clé du domicile, et toute session ouverte depuis la
fenêtre (tables, requête, relevé manuel) déchiffre la cible sous cette même
clé (`targetOf(row, row.workspace_id)`). Modifier et supprimer restent des
gestes du domicile ; la fenêtre lit, explore et relève.

### 2.2 Aucun secret ne redescend

Deux secrets par base, chacun dans sa colonne et jamais dans `content` : le mot
de passe de la base, et celui du tunnel (mot de passe SSH ou clé privée). Les
DTO n'en portent qu'un booléen (`hasPassword`, `access.hasSecret`).

Corollaire sur les formulaires : un champ laissé vide **conserve** le secret en
place, le panneau Général ne l'envoie pas. Le client ne peut pas renvoyer un
secret inchangé, puisqu'il ne l'a jamais reçu ; la commande, elle, admet une
chaîne vide pour l'effacer.

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

Les deux tables du module (`database_connections`, `database_alerts`) datent
du socle (068, complétée par la 070) et sont en allowlist dans
`deveye-feature.json` ; `project_database_links`, de la même migration,
appartient à **Projets** (voir §2.5).

### 2.5 Projets et le module se lisent par contrat, jamais par table

Le module ne lit **aucune** table de Projets, et Projets ne lit de la table des
bases que l'ordre d'affichage (une jointure admise, comme pour un dépôt git).
Trois contrats publiés dans `@deveye/types/sdk/providers.ts` portent tout le
reste :

| Contrat                    | Qui l'offre                                                                    | Qui le lit                               | Ce qu'il dit                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_ITEMS_PROVIDER`  | le service du module                                                           | `projects.databaseLink` (module Projets) | « cette base existe-t-elle dans cet espace ? » (domicile seul), avant de relier ; module absent = liaison refusée proprement                                                            |
| `PROJECTS_USAGE_PROVIDER`  | le service du module Projets (`features/projects/src/server/usageProvider.ts`) | `database.list` / `get` (module)         | combien de projets de l'espace **appelant** relient chaque base, et lesquels, avec leur titre (étage ouvert, `'Sans titre'` à défaut) ; contrat absent = zéro projet, jamais une erreur |
| `DATABASE_BACKUP_PROVIDER` | le service du module                                                           | Sauvegardes                              | ses bases nommées et un accès ouvert, tunnel compris (voir [Sauvegardes](../backup/README.md))                                                                                          |

Corollaire visible : les projets listés et comptés sur une base sont ceux de
l'espace **d'où l'on regarde**. Une base projetée montre les projets de la
fenêtre, pas ceux de son domicile.

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
été : `DatabaseMonitor` (aujourd'hui `src/server/service.ts`) appelait
`UptimeMonitor.resolveChannels`, au motif que
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
(`Services/notifications.ts`), atteint par la façade `notify` du SDK
(`deps.deveyeFor(ws).notify.send(alert, { itemId: databaseId })` : c'est
`itemId` qui choisit la route de LA base) ; `DatabaseMonitor` en gardait une
copie mot pour mot, alors que ce module existait précisément pour l'éviter.
La mise en page Discord est `src/server/notice.ts`, sur les helpers partagés
de `Services/notices/shared.ts` (le seul import de l'app par le module, au
privilège de native commenté). Voir `Docs/NOTIFICATIONS.md`.

Les alertes s'écrivent dans l'onglet **Alertes** des réglages de la base
(onglet personnalisé du manifest, `DatabaseAlertsPanel`), qui ouvre le
dialogue de la feature (`AlertDialog`) ; la fiche n'en montre que l'état
(franchie, dernières mesures). Le bouton **« Essayer »** de ce dialogue est le
cœur de l'écran, pas un extra : il évalue les conditions telles qu'on vient de
les écrire (`database.alertTest`), sans rien enregistrer ni notifier. Sans lui,
on choisirait un seuil à l'aveugle et l'on découvrirait son erreur par une
notification, la nuit.

Les quatre fonctions pures de l'évaluation (`compare`, `runConditions`,
`isFiring`, `renderMessage`) vivent dans `src/server/rules.ts`, partagées par
le relevé et l'essai à blanc : une condition ne peut pas franchir d'un côté et
pas de l'autre.

---

## 4. Les tunnels

Quatre chemins, décrits par `access.kind` :

| Chemin   | Quand                                                         |
| -------- | ------------------------------------------------------------- |
| `direct` | le serveur joint l'hôte lui-même                              |
| `ssh`    | on a un compte sur une machine du réseau (rebond)             |
| `socks`  | un VPN est déjà monté ailleurs et expose un proxy SOCKS5      |
| `device` | la base n'est joignable que depuis un appareil qui a un agent |

**Par un appareil.** L'agent ouvre la connexion de son côté et la relaie sur sa
session (`agents.openTcp`) : l'hôte et le port sont ceux que voit la machine,
`127.0.0.1` pour une base qui n'écoute que sur elle. Trois verrous : le droit
« Accès au réseau de l'appareil » d'Appareils, vérifié à l'enregistrement puis
à chaque connexion pour le membre qui a choisi l'appareil (`authorUserId` dans
`access_content`, sans colonne) ; la version de l'agent (sonde `tunnel`) ; et la
machine elle-même, qui ne joint que sa boucle locale sauf hôtes listés dans
`tunnel_targets`, et refuse tout sous `allow_tunnel = false`. Une base à un
appareil hors ligne échoue avec ce motif, comme une base éteinte.

**Un écouteur local, pas une socket passée au pilote.** `mysql2` accepte une
socket existante, `pg` non — il veut ouvrir la sienne vers un hôte et un port. Un
petit écouteur sur `127.0.0.1:0` donne aux deux pilotes ce qu'ils savent
consommer, sans rien supposer de leur implémentation. `127.0.0.1` et non
`0.0.0.0` : ce relais n'a aucune raison d'être joignable de l'extérieur, et
l'exposer ouvrirait un accès à la base sans authentification. Le `direct` y
passe aussi, pour que le nom soit résolu sous le garde et non par le pilote.

**Le garde des appels sortants.** L'hôte de la base en `direct`, le rebond SSH
et le proxy SOCKS sont saisis par un membre : chacun passe par
`assertAllowedOutboundHost` puis `publicLookup` (le rebinding DNS entre les
deux). Une adresse privée ou locale n'est joignable que sur une installation
qui les ouvre (`OUTBOUND_ALLOW_PRIVATE`) ; sinon, un compte viserait le réseau
interne du serveur, sa propre base comprise. La cible derrière un rebond ou un
proxy est résolue de l'autre côté, et n'est pas gardée.

La clé privée reste **en mémoire** : jamais de fichier temporaire, qui
survivrait à un arrêt brutal.

**Un tunnel est toujours rendu avec son `close()`, et l'appelant le ferme dans un
`finally`** — y compris quand la session échoue à s'ouvrir _après_ le tunnel.
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
(`src/server/explore.ts`) le cherchent dans le catalogue réel et rendent
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
dangereux : la valeur reste liée, seul son _sens_ pour `LIKE` change. Les deux
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
l'interface. Sans clé, aucune condition ne désigne _une_ ligne : un `UPDATE` en
toucherait plusieurs, un `DELETE` en emporterait autant, et rien ne permettrait
de revenir en arrière. Mieux vaut ne pas savoir faire que faire trop.

### 5.5 Suivre une clé étrangère

Cliquer une cellule contrainte ouvre la table visée **filtrée sur la valeur
pointée**, et auréole la ligne quelques secondes. Filtrer plutôt que calculer la
page où elle se trouve : ce calcul supposerait un ordre stable et une clé d'une
seule colonne, deux hypothèses que rien ne garantit. Le critère reste visible et
se retire d'un clic — on voit donc _pourquoi_ on ne voit qu'une ligne.

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

Tout vit dans `DevEye/features/database/` ; les chemins ci-dessous y sont
relatifs.

### Contrats — `src/contracts/`

```
domain.ts      schémas, lignes SQL, bornes de longueur
commands.ts    24 commandes, préfixe unique `database.`
```

`@deveye/types` ne garde que l'identité (`database` dans le registre, le
descripteur : `notifies`, `hasItems`, `shareTier: 'open'`) et les trois
contrats de `sdk/providers.ts` (§2.5). `projects.databaseList` / `databaseLink`
/ `databaseUnlink` sont des commandes du module Projets
(`features/projects/src/contracts/commands.ts`).

### Serveur — `src/server/`

```
index.ts       serverEntry : createRepo, features, createService (le relevé, les
               deux providers publiés), items (domicile et intitulé d'une base)
repo.ts        lectures enrichies (alertes comptées), alertes ; sur SdkQueryable
_shared.ts     Stored*, nameRef, readJson, loadDatabase, databaseCipherFor,
               toDatabase, toAlert, reloadDatabase, le contrat de Projets, le
               singleton du relevé (setMonitor / monitorOf)
crud.ts        l'inventaire : count, list, get, add, update, remove, reorder
probe.ts       ce qui joint un serveur sur un geste : test, testDraft, inspect,
               query ; `withSession` (ouvre, fait, referme)
explore.ts     les tables : structure, pages, écriture de lignes, terminal, export
alerts.ts      les conditions, leur essai à blanc
handlers.ts    l'agrégat des quatre fichiers, ce que serverEntry.features expose
rules.ts       compare, runConditions, isFiring, renderMessage (fonctions pures)
service.ts     DatabaseMonitor : relevé périodique + évaluation + notification,
               sur FeatureServiceDeps (ticker, cipherFor, notify, live.changed)
engine.ts      adaptateurs MySQL et PostgreSQL, les deux gardes d'instruction
tunnel.ts      direct, SSH (ssh2) et SOCKS5 (socks) sous le garde sortant, appareil
device.ts      le droit réseau d'un appareil, la liste du formulaire, le relais
notice.ts      la mise en page Discord d'une alerte
*.test.ts      handlers, rules, explore (l'export), engine (les gardes), service,
               tunnel (le garde sortant, l'appareil)
```

Côté Projets (le module `features/projects`) : la table de liaison et ses
lectures (`src/server/repo/links.ts` : `listDatabaseIds`, `linkDatabase`,
`unlinkDatabase`, `unlinkAllDatabases`, `listDatabaseUsage`,
`countDatabaseLinks`), le pointeur d'un projet (`src/server/databaseLink.ts`)
et le contrat offert aux modules (`src/server/usageProvider.ts`). Côté app, les
migrations du socle : `068_databases.sql` (les trois tables),
`070_database_response_time.sql` (`last_elapsed_ms`),
`085_deploy_sync_notifications.sql` (la ligne `database` des canaux).

### Client — `src/client/`

```
index.tsx                clientEntry : Widget, Full, settingsPanels (general, alerts), providers
api.ts                   featureApi(manifest)
provider.tsx             ce que Projets compose (DATABASE_CLIENT_PROVIDER) : la liste des
                         bases de l'espace, une base reliée autonome (LinkedDatabase), le
                         dialogue de création
Database.tsx             liste + détail ; possède le niveau live `l1`
DatabaseList.tsx         les cartes + le glisser-déposer (useDragReorder du barrel)
DatabaseHeader.tsx       l'en-tête d'une base (retour ou « Délier », titre, Tester, Relever,
                         le bouton commun des réglages), partagé avec l'onglet d'un projet
DatabaseDetail.tsx       état, alertes (leur état seulement), explorateur, projets liés
DatabaseView.tsx         le contenu partagé avec l'onglet d'un projet
DatabaseDialog.tsx       ajouter une base : moteur, connexion et tunnel ; une base ajoutée se
                         règle dans sa fiche
DatabaseGeneralPanel.tsx Réglages → Général d'une base : connexion, accès, relevé, cadence, tables
                         à l'ouverture, suppression
ConnectionFields.tsx     les champs de connexion et d'accès, et leur modèle, partagés entre le
                         dialogue d'ajout et le panneau Général
DatabaseAlertsPanel.tsx  Réglages → Alertes d'une base : la liste des règles, qui ouvre AlertDialog
AlertDialog.tsx          conditions, opérateur, message, essai à blanc ; zone danger pour supprimer
ProbeLine.tsx            « en cours », puis le résultat d'un essai, effacé après 10 s
TableExplorer.tsx        tables, contenu, sélection, tri, clés étrangères, plein écran
Pagination.tsx           Précédent / Suivant + les numéros, avec coupures
ResultTable.tsx          le tableau d'un jeu de résultats, et sa vue en grand
RowDialog.tsx            ajout / modification d'une ligne, NULL explicite, colonnes auto
StructureDialog.tsx      colonnes, contraintes, index, copie mise en forme
SearchDialog.tsx         critères colonne / opérateur / valeur
TerminalDialog.tsx       instruction libre, aperçus cliquables, confirmation des écritures
ExportDialog.tsx         portée, format, plages d'identifiants, estimation de taille
DatabaseWidget.tsx       la carte d'accueil
rowKey.ts format.ts style.module.css
```

Trois composants de cette liste servent **plusieurs écrans chacun**, et c'est
volontaire : `ProbeLine` porte le retour d'un essai dans la fiche, dans le pied
du dialogue d'ajout et dans le panneau Général (tous doivent dire la même chose
et s'effacer pareil), `ConnectionFields` est le formulaire de connexion et
d'accès du dialogue d'ajout comme du panneau Général (un seul formulaire, jamais
une copie réduite), et `ResultTable` rend l'aperçu du terminal comme sa vue en
grand : une ligne vue en petit est ainsi forcément la même que celle vue en
grand.
`DatabaseHeader` et `DatabaseView` le sont aussi, entre la feature et l'onglet
d'un projet : ce qui diffère d'un contexte à l'autre entre par leurs props, le
reste est identique et doit le rester.

L'onglet **Bases** d'un projet (`features/projects/src/client/Database/`) est
une enveloppe mince sur `projects.databaseList` / `databaseLink` /
`databaseUnlink`, qui compose les composants du module par
`moduleClientProvider(DATABASE_CLIENT_PROVIDER)` (la liste des bases de
l'espace, une base reliée montrée en entier, le dialogue de déclaration : le
vrai formulaire, jamais une copie réduite), et dégrade proprement quand le
module est absent. Il **n'apparaît qu'à partir de la première base reliée** ;
sans liaison, il repart dans le menu « + » de la barre d'onglets — voir
[Projets](../projects/README.md) §2.

---

## 7. Pièges

### Le filet de démarrage ne voit qu'une partie du module

`MUTATION_VERB` cherche un verbe **juste après le point**. Il attrape donc
`database.add`, `database.update`, `database.remove`, `database.reorder` — mais
**pas** `database.alertAdd`, `alertUpdate`, `alertRemove`, ni
`projects.databaseLink`. Leurs `mutates` se relisent à la main.

### `database.remove` ne ravive que son sujet

La commande native déclarait `mutates: ['database', 'projects']` : les projets
liés perdaient leur base, leur onglet devait suivre. Le module ne nomme que
son sujet (`mutates: true` ; le SDK admet une liste depuis le rapatriement de
Projets, ce module n'en use pas) : les écrans de Projets qui montrent une base
suivent déjà `database.detail` / `database.list`, et ce qui n'est plus ravivé
à la suppression, c'est le tableau d'un projet et les compteurs de ses onglets,
qui se remettent à jour à leur prochaine lecture.

### Un relevé manuel et un relevé automatique suivent le même chemin

`database.inspect` appelle `DatabaseMonitor.checkNow` (`src/server/service.ts`),
exactement comme l'ordonnanceur, par le singleton que `createService` pose
pour les handlers (`monitorOf()`, patron `setEngine` de CloudSync). Deux
implémentations auraient divergé au premier ajustement, et c'est le genre de
divergence qui ne se voit qu'en production — « ça marche quand je clique, mais
pas la nuit ».

### Une alerte s'écrit chez elle

`database.alertAdd` range l'alerte dans l'espace **appelant**, sous sa clé, et
le relevé n'évalue que les alertes du domicile de la base, lisibles sous la
sienne : une alerte posée depuis une fenêtre sur une base projetée serait
inerte, et la fiche (qui liste les alertes du domicile) ne la montrerait même
pas. Le serveur la **refuse** donc (`forbidden`, comme `database.update`), et
l'interface ne propose les réglages d'une base (Général, Alertes) qu'à son
domicile. `alertTest` reste permis d'une fenêtre : il évalue sans rien écrire.

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
# Les tests du module, sur le harnais du SDK (aucune base, aucun réseau)
DOTENV_CONFIG_PATH=.env.test npx tsx --test "features/database/src/**/*.test.ts"
npm run typecheck && npx tsc -p features/tsconfig.server.json --noEmit
npx eslint features/database/src/server features/database/src/contracts features/database/src/manifest.ts

rsync -a --delete DevEye-Types/src/ DevEye/node_modules/@deveye/types/src/
diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
./ci.sh
```

**Au démarrage** : zéro avertissement `mutates`, aucun « préfixe de commande
inconnu », et les deux providers du module visibles de Projets et de
Sauvegardes (relier une base à un projet, la choisir comme source de
sauvegarde).

**Vérifié sur le harnais du SDK** (`src/server/*.test.ts`), sans base ni
réseau : les handlers (restrictions par élément, projections sous le codec
d'origine, contrat de Projets présent ou absent, secrets conservés ou effacés,
ménage à la suppression, dernières mesures conservées), les règles
d'évaluation (une condition en échec ne franchit pas, en `and` et en `or`), le
service (un échec conserve la version et la taille, les alertes notifient aux
transitions dans les deux sens sur la route de la base, `last_fired_at` posé à
la montée seulement, une alerte cassée n'arrête pas les autres), l'export
(les trois formats sur des valeurs piégeuses, JSON valide sur une base entière
avec une table vide, pagination par 3 sur 12 lignes, les deux plafonds, table
inconnue et clé composite refusées avant le moteur) et les deux gardes
d'instruction.

**Vérifié contre un vrai serveur MySQL 8.0**, sur des bases jetables créées et
détruites pour l'occasion — jamais sur les tables de DevEye :

- _le socle_ — inventaire, liste des tables, pagination, requête libre, les
  quatre messages d'erreur de connexion, l'évaluation des conditions (y compris
  une condition cassée qui n'interrompt pas les autres), l'interpolation du
  message, le chemin nominal d'un **tunnel SOCKS5** (proxy d'essai monté pour
  l'occasion, avec contrôle qu'aucun écouteur ne reste ouvert), et `testDraft` ;
- _l'explorateur_ (33 cas) — structure lue au complet (ordre des colonnes, clé
  primaire, auto-incrément, défaut, commentaire, index unique ou non, clé
  étrangère et sa cible, table sans clé), insertion, modification par clé,
  suppression multiple, recherche `contient` / `est nul` / deux critères en OU
  avec tri, **le `%` saisi cherché littéralement**, une valeur d'injection qui
  reste une valeur, le refus du serveur sur une clé étrangère orpheline et sur
  la suppression d'un parent référencé, le terminal en lecture et en écriture ;
- _l'export_ (18 cas) — les trois formats sur des valeurs piégeuses (guillemet,
  apostrophe, virgule, `NULL`, accents), JSON qui reste **un document valide**
  y compris sur une base entière avec une table vide, pagination par 3 sur 12
  lignes sans perte ni doublon, les deux plafonds atteints et signalés, et une
  table inconnue qui n'atteint jamais le moteur.

**Vérifié hors serveur**, sur les fonctions découpées dans les fichiers livrés
plutôt que recopiées :

- _la fabrication des requêtes_ (32 cas) — citation d'un identifiant hostile,
  valeur qui reste liée, numérotation PostgreSQL qui se poursuit au-delà du
  `WHERE`, jokers d'un `LIKE` transmis tels quels, `IS NULL` plutôt que `= NULL`,
  appariement d'une clé composite, regroupement des index, les deux gardes
  d'instruction ;
- _les gardes d'écriture_ (13 cas) — colonne inconnue refusée, clé composite
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
