# Offres et quotas

Ce que le cœur sait d'une offre : presque rien. Un module privé (la facturation)
dit quelle offre a un compte ; les modules disent ce qu'ils comptent ; le cœur
fait le lien. **Sans module qui fournit l'offre, tout est illimité** : c'est le
comportement d'une installation auto-hébergée, et il ne demande aucun réglage.

## Les trois rôles

| Qui                      | Quoi                                                                                                                 | Où                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Un module qui crée       | déclare `manifest.quotas` (`{ key, label, stock? }`) et appelle `ctx.quota.assert(key, compteur)` avant de créer     | son manifest, son handler de création     |
| Un module qui a un stock | liste ses éléments (`server.quotas.<clé>.list`) et exclut ceux en pause de ce qu'il fait tourner                     | son entrée serveur, ses listes d'échéance |
| Le cœur                  | résout le compte visé, lit son offre, compare, lève `quota_exceeded`, et tient les pauses                            | `src/Services/quota.ts`, `planPauses.ts`  |
| Le fournisseur d'offre   | offre `ACCOUNT_PLAN_PROVIDER` : `planFor(userId, { fresh? })` rend `{ id, label, limits, trialEndsAt?, changesAt? }` | `FeatureService.providers` du module      |

Les limites sont nommées `<featureId>.<quotaKey>` (`uptime.monitors`). Une clé
absente de `limits` est illimitée.

## Règles

- **Le compte visé est le propriétaire de l'espace**, pas l'appelant : dans un
  espace partagé, ce qu'un membre crée pèse sur l'offre de celui qui l'héberge.
  Le compteur reçoit donc les ids de **tous** les espaces de ce propriétaire.
- **Le compteur n'est jamais appelé quand c'est illimité** : sans fournisseur, un
  quota ne coûte aucune requête.
- **Rien n'est jamais supprimé.** Après un retour à une offre plus basse, une
  limite de flux refuse l'usage suivant, une limite de stock met l'excédent en
  pause (voir plus bas).
- **Un fournisseur qui lève vaut illimité pour une création**, et l'erreur est
  journalisée : une panne de la facturation ne bloque jamais une création. Les
  pauses, elles, restent en l'état (voir le réconciliateur).
- La limite est souple : compter puis insérer n'est pas atomique, deux créations
  simultanées peuvent la dépasser d'une unité.

## Stock et flux

Une limite est un **flux** quand elle se vérifie à chaque usage : les vues d'un
mois, la taille d'un fichier, les octets stockés au moment d'un envoi. Rien de
plus à faire : dès que l'offre baisse, l'usage suivant est refusé.

Une limite est un **stock** (`stock: true`) quand ce qu'elle compte existe et
coûte tant qu'il existe : une sonde, un appareil, un domaine. Créer au-delà est
refusé comme pour un flux, et quand l'offre passe sous ce qui existe, **l'hôte met
l'excédent en pause** :

- les plus anciens restent actifs, rangés par création sur tous les espaces du
  propriétaire : le module les liste du plus ancien au plus récent, sous le même
  `WHERE` que son compteur ;
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

Le balayage du démarrage passe sur **tous** les propriétaires : une limite neuve
ou abaissée arrive avec un déploiement, avant qu'aucune pause n'existe. Celui de
chaque jour rattrape ce qu'aucun déclencheur n'a vu.

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

## Ce que le cœur borne lui-même

Les espaces et les domaines ne sont pas des modules : le cœur applique trois limites sans manifest,
par `assertCoreLimit` (`src/features/_quota.ts`), avec la même comparaison que les
modules (`assertPlanLimit`, `src/Services/quota.ts`).

| Clé                 | Compte                                    | Où                              |
| ------------------- | ----------------------------------------- | ------------------------------- |
| `workspace.shared`  | les espaces partagés qu'un compte possède | `features/workspace/add.ts`     |
| `workspace.members` | les membres d'UN espace partagé           | `features/workspace/members.ts` |
| `domains.hosts`     | les noms web distincts de ses espaces     | `features/domain/index.ts`      |

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

## Côté client

- `quota_exceeded` ouvre partout la même invite (`Components/QuotaPrompt`),
  déclenchée par le client WS : aucun module n'a à traiter ce refus. Son bouton
  « Voir les offres » n'existe que si un module a une entrée de compte. Avec
  `details.paused`, elle dit qu'un élément est en pause plutôt qu'une création
  refusée.
- `PlanPausedBadge` marque un élément en pause, `PlanPausedNotice` en tête d'une
  liste dit combien et pourquoi ; `usePlanPauses()` rend les comptes par clé,
  que l'écran de l'offre affiche.
- `useAccountPlan()` rend l'offre du compte, tenue à jour en direct : le module
  appelle `live.accountChanged(userId)`, le sujet `account` relit `user.plan`.
  `null` veut dire « en chargement » **ou** « aucun fournisseur », jamais
  « offre gratuite ».

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
