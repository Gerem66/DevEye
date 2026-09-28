# Offres et quotas

Ce que le cœur sait d'une offre : presque rien. Un module privé (la facturation)
dit quelle offre a un compte ; les modules disent ce qu'ils comptent ; le cœur
fait le lien. **Sans module qui fournit l'offre, tout est illimité** : c'est le
comportement d'une installation auto-hébergée, et il ne demande aucun réglage.

## Les trois rôles

| Qui                      | Quoi                                                                                                                            | Où                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Un module qui crée       | déclare `manifest.quotas` (`{ key, label, stock?, perOperation? }`) et appelle `ctx.quota.assert(key, compteur)` avant de créer | son manifest, son handler de création    |
| Un module qui compte     | donne à chaque quota de quoi le compter : `server.quotas.<clé>.list` pour un stock, `.count` pour un flux                       | son entrée serveur                       |
| Un module qui a un stock | exclut les éléments en pause de ce qu'il fait tourner                                                                           | ses listes d'échéance                    |
| Le cœur                  | résout le compte visé, lit son offre, compare, lève `quota_exceeded`, et tient les pauses                                       | `src/Services/quota.ts`, `planPauses.ts` |
| Le fournisseur d'offre   | offre `ACCOUNT_PLAN_PROVIDER` : `planFor(userId, { fresh? })` rend `{ id, label, limits, priority, trialEndsAt?, changesAt? }`  | `FeatureService.providers` du module     |

Les limites sont nommées `<featureId>.<quotaKey>` (`uptime.monitors`). Une clé
absente de `limits` est illimitée.

## Règles

- **Le compte visé est le propriétaire de l'espace**, pas l'appelant : dans un
  espace partagé, ce qu'un membre crée pèse sur l'offre de celui qui l'héberge.
  Le compteur reçoit donc les ids de **tous** les espaces de ce propriétaire.
- **Le compteur n'est jamais appelé quand c'est illimité** (`assert` comme
  `ctx.quota.usage`) : sans fournisseur, un quota ne coûte aucune requête. Seul
  le relevé d'un compte (`'accounts.usage'`, plus bas) compte toujours.
- **Rien n'est jamais supprimé.** Après un retour à une offre plus basse, une
  limite de flux refuse l'usage suivant, une limite de stock met l'excédent en
  pause (voir plus bas).
- **Un fournisseur qui lève vaut illimité pour une création**, et l'erreur est
  journalisée : une panne de la facturation ne bloque jamais une création. Les
  pauses, elles, restent en l'état (voir le réconciliateur).
- La limite est souple : compter puis insérer n'est pas atomique, deux créations
  simultanées peuvent la dépasser d'une unité.

## Stock, flux et limite par opération

Une limite est un **flux** quand elle se vérifie à chaque usage : les vues d'un
mois, les octets stockés au moment d'un envoi. Le module la compte
(`server.quotas.<clé>.count`, le compteur même que son `assert` appelle) ; dès
que l'offre baisse, l'usage suivant est refusé, et ce qui est déjà là reste.

Une limite **par opération** (`perOperation: true`) borne un seul geste, la
taille d'UN fichier à convertir : rien ne s'accumule, rien ne se compte, et
aucune entrée `server.quotas` ne la suit.

Une limite est un **stock** (`stock: true`) quand ce qu'elle compte existe et
coûte tant qu'il existe : une sonde, un appareil, un domaine. Créer au-delà est
refusé comme pour un flux, et quand l'offre passe sous ce qui existe, **l'hôte met
l'excédent en pause** :

- les plus anciens restent actifs, rangés par création sur tous les espaces du
  propriétaire : le module les liste (`server.quotas.<clé>.list`) du plus ancien
  au plus récent, sous le même `WHERE` que son compteur, et cette liste fait
  aussi son compte ;
- l'état de pause vit à part (`quota_pauses`), distinct de l'interrupteur de
  l'utilisateur, qui retrouve son propre réglage à la reprise ;
- un élément en pause reste lisible, modifiable et supprimable, et rien de lui ne
  tourne, ni à l'heure ni à la demande (`ctx.quota.assertActive`) ;
- tout reprend seul quand la limite remonte ou qu'une place se libère.

Déplacer un élément vers l'espace d'un autre propriétaire est refusé quand
l'offre de celui-ci est pleine (`sharing/move.ts`) : sans ça, un élément ancien
qui arrive mettrait en pause le plus récent de la cible.

### Le réconciliateur

`src/Services/planPauses.ts` repasse un propriétaire à la fois : l'offre lue sans
cache (`planFor(userId, { fresh: true })`), la différence écrite en transaction,
puis le miroir en mémoire, puis `onPlanPause` des modules et les écrans. Un
fournisseur qui lève ne change rien : ici, une panne de la facturation ne vaut
pas « illimité », elle relancerait tout.

| Quand                                                                                        | Par                                                               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| un changement d'offre annoncé (paiement, offre accordée)                                     | `live.accountChanged(userId)` du fournisseur                      |
| la fin d'un essai ou d'une offre accordée                                                    | `AccountPlan.changesAt`, relevé dans `quota_rechecks` à la minute |
| une commande qui modifie, dans un module où le compte a des pauses                           | l'enveloppe des handlers (`_sdk/register.ts`)                     |
| un membre qui part, un domaine retiré, un espace supprimé, un déplacement                    | les commandes du cœur                                             |
| le démarrage et chaque jour (tous les propriétaires), chaque heure (ceux qui ont des pauses) | le service lui-même                                               |
| la priorité aux abonnés donnée ou levée (tous les propriétaires, en fond)                    | `Services/maintenance.ts`                                         |
| un appareil neuf qui s'enrôle (des enrôlements simultanés passent tous la vérification)      | `src/agent/routes.ts`                                             |

Le balayage du démarrage passe sur **tous** les propriétaires : une limite neuve
ou abaissée arrive avec un déploiement, avant qu'aucune pause n'existe. Celui de
chaque jour rattrape ce qu'aucun déclencheur n'a vu.

### La priorité aux abonnés

Le levier d'une forte affluence (page « Accès et maintenance »,
`site_maintenance.priority`, commun à tous les serveurs qui partagent la base
comme `quota_pauses`). Le fournisseur dit qui passe en priorité
(`AccountPlan.priority`) ; le cœur en tire les conséquences, et aucun module n'a
rien à faire :

- `limitIn` rend 0 à toute clé d'un compte sans priorité (`isHeld`) : toute
  lecture de limite passe par là, celle du réconciliateur comprise (injectée
  dans son hôte). Son stock entier se met en pause et ses créations sont
  refusées, flux compris. `planOf` reste brut : `user.plan` dit la vraie offre.
- Le refus porte `details.priority` et son propre motif, dans
  `assertPlanLimit` comme dans `assertActive`.
- Donner ou lever la priorité passe sur tous les propriétaires, en fond :
  quelques minutes pour mille comptes, les gestes des comptes passant devant.
  Le journal en dit le début et la fin.
- Sans fournisseur, personne n'est tenu, et la page ne propose pas le réglage.

Ce qui ne passe pas par les pauses continue : les sauvegardes vers le stockage
de l'utilisateur, les minuteurs de Rdv, les relances de Facturation et de
Finances, la passe lente de Sentinel. Les requêtes d'échéance excluent chaque
élément en pause par `NOT IN (...)` : la liste compte alors tous les éléments
des comptes gratuits, sans souci pour quelques milliers.

### Aux points d'étranglement

- Exclure les ids en pause **dans le SQL** d'une liste d'échéance
  (`id NOT IN (...)`, liste vide gardée) : filtrer après un `LIMIT` laisserait les
  éléments en pause, dont l'horodatage n'avance plus, affamer les autres.
- Lire le miroir **après** tout cache (page publique, carte en mémoire) : aucun
  crochet d'invalidation n'est alors nécessaire.
- `onPlanPause` ne sert qu'à ce qui est tenu ouvert : une connexion d'agent, une
  session IMAP, un minuteur.
- Un stock qui compte autre chose que les éléments de la feature leur donne un
  identifiant à part (`public:<id>` pour la page publique d'un projet) : un
  déplacement vérifie l'offre de la cible pour les identifiants qui sont celui
  de l'élément déplacé, et une page qui reste derrière lui n'a pas à peser.

Le boot refuse un module dont `server.quotas` ne suit pas son manifest : un stock
sans liste, un flux sans compteur, une limite par opération comptée, une clé non
déclarée (`quotaEntryProblems`, `_sdk/register.ts`).

## L'usage d'un compte

Deux lectures, pour dire où l'on en est avant le refus :

- `ctx.quota.usage(key)` : le propriétaire de l'espace face à une limite du
  module, `{ used, limit }`, ou `null` quand elle est illimitée (rien n'est
  compté alors). Une limite par opération lève.
- `ctx.deveye.usage.of(userId)` / `ofMany(userIds)` et `deps.usage` (capacité
  `'accounts.usage'`) : toutes les limites de l'app pour un compte, bornées ou
  non, `{ kind, used, paused }` par clé (`kind` : stock, flux ou par opération). Un membre ne lit que la sienne, un
  administrateur global celle de tous ; côté service, la capacité seule en garde
  l'accès. C'est ce que le module d'offre montre à côté des limites qu'il fixe.

Ce que `used` veut dire :

| Sorte               | `used`                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| stock               | ce qui existe, en pause compris (`paused` en dit combien)                                |
| flux                | le mois en cours (UTC ; Facturation, le fuseau par défaut), ou les octets tenus          |
| par opération       | `null`                                                                                   |
| `workspace.members` | l'espace partagé le plus peuplé, propriétaire compris ; `paused` est celui de cet espace |
| `domains.hosts`     | les noms distincts ; `paused` compte des noms, pas des lignes                            |

Le compte porte sur les espaces que le compte **possède**, jamais sur ceux où il
n'est que membre. `src/Services/quotaUsage.ts` mesure les sources une à une, et
quatre comptes à la fois au plus pour `ofMany` (environ 28 petites requêtes par
compte) : un relevé de tous les comptes laisse le reste du pool aux membres. Une
source qui tombe fait échouer la lecture entière, en nommant sa clé.

## Ce que le cœur borne lui-même

Les espaces et les domaines ne sont pas des modules : le cœur applique trois limites sans manifest,
par `assertCoreLimit` (`src/features/_quota.ts`), avec la même comparaison que les
modules (`assertPlanLimit`, `src/Services/quota.ts`).

| Clé                 | Compte                                    | Où                              |
| ------------------- | ----------------------------------------- | ------------------------------- |
| `workspace.shared`  | les espaces partagés qu'un compte possède | `features/workspace/add.ts`     |
| `workspace.members` | les membres d'UN espace partagé           | `features/workspace/members.ts` |
| `domains.hosts`     | les noms web distincts de ses espaces     | `features/domain/index.ts`      |

Leur usage se lit par `coreUsageSources` (`src/features/_quota.ts`), sous la
règle de chaque garde.

En pause, un espace partagé ferme ses portes à ses membres, mais pas à son
propriétaire ; un membre en pause (les derniers arrivés d'abord, jamais le
propriétaire) perd l'accès là où le résolveur le décide (`_access.ts`), et voit
l'espace grisé dans son sélecteur. Un nom de domaine en pause sort du proxy et
n'est plus `verified` pour les modules, qui cessent de le servir.

**L'offre d'un espace est celle de son propriétaire.** Tous ses espaces tirent
sur la même réserve, et ses membres y travaillent avec leur propre compte, quel
qu'il soit : c'est le propriétaire qui héberge. Ces deux limites sont ce qui
empêche un seul abonnement d'héberger une équipe entière. Un membre gratuit d'un
espace Pro n'emporte rien chez lui : dans son espace personnel, c'est son offre à
lui qui s'applique.

`domains.hosts` compte les noms des fonctionnalités dont les domaines servent
des pages (`manifest.domains.web`), tous espaces du propriétaire confondus : un
même nom déclaré pour Rendez-vous, Facturation, les pages de statut d'Uptime ou
les tableaux publics de Projets compte pour un. Un tel nom
coûte un certificat sur le compte ACME de tout le serveur, et donne à une page
servie ici l'adresse de son choix. Les domaines de courrier ne s'y comptent pas.
L'onglet Domaines dit la limite avant le refus (`domain.list` rend `quota`).

## Une taille plutôt qu'un nombre

Un quota peut compter des octets : `{ key: 'storage', label: 'de stockage', unit:
'bytes' }`. La limite de l'offre est alors en octets, et le refus l'écrit comme
une taille (« 1 Go de stockage »).

Ce qui se crée hors de toute commande (les octets qu'un agent envoie) se borne
depuis le service : `deps.quotaFor(workspaceId)` rend le même `SdkQuota`, pour le
propriétaire de cet espace. CloudSync l'interroge une fois par session, avant la
première montée : une session qui dépasserait l'offre s'arrête entière, avec sa
raison, et les descentes comme les suppressions restent possibles.

## Des valeurs par défaut selon l'offre

Ce qui coûte à l'hôte sans être borné peut partir d'un défaut plus sobre pour
un compte qui ne paie pas, que chacun change s'il le veut : la plupart gardent
le défaut, et ce sont eux qui font le volume. `ctx.quota.paid()` (et
`deps.quotaFor(ws).paid()`) dit si l'offre du propriétaire paie : Pro, essai
compris, une offre accordée sur Pro (`priority`), un administrateur, ou aucun
fournisseur (auto-hébergé). La même règle, `isPaidPlan(plan)` dans
`@deveye/types/sdk`, sert le cœur. Ce n'est jamais un refus, qui passe par
`limit` et `assert`.

| Défaut                            | Payant | Gratuit | Où                                                      |
| --------------------------------- | ------ | ------- | ------------------------------------------------------- |
| Cadence d'un service Uptime neuf  | 1 min  | 5 min   | `uptime.add` sans `intervalSeconds`                     |
| Cadence de collecte d'un appareil | 1 min  | 5 min   | `metric_interval_seconds` à `NULL` (`agent/cadence.ts`) |

Un service Uptime garde la cadence reçue à sa création. Un appareil laissé au
défaut la suit : quand le réconciliateur voit un compte passer d'une offre
payante à la gratuite ou l'inverse, la configuration de ses agents leur est
repoussée (`tierChanged`, `_planPauses.ts`).

## Côté client

- `quota_exceeded` ouvre partout la même invite (`Components/QuotaPrompt`),
  déclenchée par le client WS : aucun module n'a à traiter ce refus. Son bouton
  « Voir les offres » n'existe que si un module a une entrée de compte. Avec
  `details.paused`, elle dit qu'un élément est en pause plutôt qu'une création
  refusée ; avec `details.priority`, que le service est réservé aux abonnés.
- `PlanPausedBadge` marque un élément en pause, `PlanPausedNotice` en tête d'une
  liste dit combien et pourquoi ; `usePlanPauses()` rend les comptes par clé,
  que l'écran de l'offre affiche.
- `useAccountPlan()` rend l'offre du compte, tenue à jour en direct : le module
  appelle `live.accountChanged(userId)`, le sujet `account` relit `user.plan`.
  `null` veut dire « en chargement » **ou** « aucun fournisseur », jamais
  « offre gratuite ».
- `usePriorityHold()` : la priorité aux abonnés tient ce compte. L'accueil
  montre alors un bandeau avec « Voir les offres », et les textes de pause
  disent la vraie raison.

## L'entrée de compte

`manifest.accountEntry` ajoute une entrée au menu du compte, sous « Sécurité », à l'icône du module,
qui ouvre `FeatureClient.AccountView` (`close`, `isAdmin`, `hint?`). Avec
`accountOnly`, le module n'a ni carte ni ligne dans l'écran des rôles, et toutes
ses commandes déclarent `access.scope: 'account'` : elles s'exécutent dans
l'espace personnel de l'appelant, quel que soit l'espace affiché.

Deux arrivées ouvrent la vue d'elles-mêmes : `/?account=<id du module>` (le
retour d'un paiement, dont le module lit le reste de l'URL) et la fin d'une
inscription qui portait un indice (`/signup?plan=…`), remis une fois en `hint`
au module qui déclare `accountEntry.signupHint`.

## La page système d'un module

`manifest.adminEntry` (`label`, `icon?`) ajoute une page aux pages système du
menu du compte, après celles de l'app, avec la pastille « Réservé aux
administrateurs » : elle ouvre `FeatureClient.AdminView` (`close`), et l'hôte ne
la rend qu'à un administrateur. Ses commandes déclarent
`access: { scope: 'account', admin: true }`. C'est la place de ce que
l'exploitant traite pour toute l'instance : les signalements d'Hébergement.
L'arrivée `/?admin=<id du module>` l'ouvre d'elle-même, pour le bouton d'un mail
envoyé par `accountMail.sendToAdmins`.
