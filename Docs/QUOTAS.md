# Offres et quotas

Ce que le cœur sait d'une offre : presque rien. Un module privé (la facturation)
dit quelle offre a un compte ; les modules disent ce qu'ils comptent ; le cœur
fait le lien. **Sans module qui fournit l'offre, tout est illimité** : c'est le
comportement d'une installation auto-hébergée, et il ne demande aucun réglage.

## Les trois rôles

| Qui                    | Quoi                                                                                                     | Où                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Un module qui crée     | déclare `manifest.quotas` (`{ key, label }`) et appelle `ctx.quota.assert(key, compteur)` avant de créer | son manifest, son handler de création      |
| Le cœur                | résout le compte visé, lit son offre, compare, lève `quota_exceeded`                                     | `src/Services/quota.ts`, `_sdk/context.ts` |
| Le fournisseur d'offre | offre `ACCOUNT_PLAN_PROVIDER` : `planFor(userId)` rend `{ id, label, limits, trialEndsAt? }`             | `FeatureService.providers` du module       |

Les limites sont nommées `<featureId>.<quotaKey>` (`uptime.monitors`). Une clé
absente de `limits` est illimitée.

## Règles

- **Le compte visé est le propriétaire de l'espace**, pas l'appelant : dans un
  espace partagé, ce qu'un membre crée pèse sur l'offre de celui qui l'héberge.
  Le compteur reçoit donc les ids de **tous** les espaces de ce propriétaire.
- **Le compteur n'est jamais appelé quand c'est illimité** : sans fournisseur, un
  quota ne coûte aucune requête.
- **Seule la création est bornée.** Après un retour à une offre plus basse, rien
  n'est supprimé ni gelé : ce qui existe reste pleinement utilisable.
- **Un fournisseur qui lève vaut illimité**, et l'erreur est journalisée : une
  panne de la facturation ne bloque jamais une création.
- La limite est souple : compter puis insérer n'est pas atomique, deux créations
  simultanées peuvent la dépasser d'une unité.

## Ce que le cœur borne lui-même

Les espaces ne sont pas un module : le cœur applique deux limites sans manifest,
par `assertCoreLimit` (`src/features/_quota.ts`), avec la même comparaison que les
modules (`assertPlanLimit`, `src/Services/quota.ts`).

| Clé                 | Compte                                    | Où                              |
| ------------------- | ----------------------------------------- | ------------------------------- |
| `workspace.shared`  | les espaces partagés qu'un compte possède | `features/workspace/add.ts`     |
| `workspace.members` | les membres d'UN espace partagé           | `features/workspace/members.ts` |

**L'offre d'un espace est celle de son propriétaire.** Tous ses espaces tirent
sur la même réserve, et ses membres y travaillent avec leur propre compte, quel
qu'il soit : c'est le propriétaire qui héberge. Ces deux limites sont ce qui
empêche un seul abonnement d'héberger une équipe entière. Un membre gratuit d'un
espace Pro n'emporte rien chez lui : dans son espace personnel, c'est son offre à
lui qui s'applique.

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
  « Voir les offres » n'existe que si un module a une entrée de compte.
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
