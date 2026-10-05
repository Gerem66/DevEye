# Les canaux d'alerte : où partent les notifications

> Ce document dit **pourquoi** ; le code dit comment. Documents voisins :
> [SECURITY_MODEL.md](./SECURITY_MODEL.md), [SOURCES.md](./SOURCES.md),
> [WORKSPACES.md](./WORKSPACES.md), [LOGS.md](./LOGS.md) (la cible Système),
> [Uptime](../features/uptime/README.md) et [Mail](../features/mail/README.md).

---

## 1. Le modèle

Une fonctionnalité qui sait prévenir le déclare : `notifies: true` dans le
registre (`src/domain/featureRegistry.ts` de `@deveye/types`) pour une
fonctionnalité du dépôt, dans son manifest pour un module externe. Dans le
registre : Sentinelle, Uptime, Déploiements, Bases de données, Sauvegardes,
Finances, Convertisseur, Facturation ; parmi les modules privés : Audit,
Rendez-vous, Hébergement.

Deux entités, et rien d'autre :

- **Un canal** est une destination (une adresse e-mail, une URL de webhook, un
  salon Discord). Il appartient à **une fonctionnalité** d'un espace
  (`notification_channels.feature`) : c'est une source de cette feature
  ([SOURCES.md](./SOURCES.md)), déclarée et corrigée dans ses réglages, comme un
  accès Dokploy l'est de Déploiements. Un salon servi par deux features s'y
  déclare deux fois : c'est le prix d'une liste gérée à un seul endroit, où
  « ajouter un canal » dans Uptime ne fait rien apparaître dans Sauvegardes.
- **Une route** lie une cible, `(espace, feature, item_id)`, à un ensemble de
  canaux de la même feature. Plusieurs canaux par route, un canal dans plusieurs
  routes. Une route ne peut désigner que des canaux de sa feature : le dépôt
  ignore les identifiants d'un autre émetteur comme ceux d'un autre espace.

### La règle de résolution

1. la cible (élément, ou la fonctionnalité pour ce qu'elle dit en son nom) a
   une route → **ses** canaux ;
2. sinon → aucun canal.

Rien n'est deviné ni hérité (`resolveRoute`, `src/Services/notifications.ts`).
Sans sélection enregistrée, rien ne part : un élément naît silencieux jusqu'à ce
qu'on lui coche des canaux. **La route est le seul endroit qui décide** : il n'y
a pas de second interrupteur (« m'alerter ») à côté d'elle, et `deliver` sans
canal rend `false`, ce qui suffit à l'émetteur pour retenir le « c'est revenu »
d'une panne jamais annoncée.

---

## 2. Les trois tables, et pourquoi trois

| Table                         | Ce qu'elle porte                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `notification_channels`       | les destinations : `feature`, `kind`, `label_enc`, `target_enc`, `mail_account_id`, `enabled`, `position` |
| `notification_routes`         | une cible de routage : `(workspace_id, feature, item_id)`, unique                                         |
| `notification_route_channels` | quels canaux cette route sert                                                                             |

La liaison est séparée parce qu'une sélection est un ensemble. Une route dont la
sélection se vide est **retirée** : une sélection vide et une sélection jamais
faite disent la même chose, le silence.

`item_id = 0` désigne la fonctionnalité elle-même : le cas des émetteurs **sans
éléments** (Sentinelle), dont les alertes ne visent rien de plus fin, et de ceux
dont rien ne part au nom d'un élément (`notifications.perItem: false`,
Finances) : l'onglet Notifications montre alors les cases de cette route à
l'échelle de la fonctionnalité. (Zéro et non NULL : une colonne d'une clé unique
ne peut pas être nulle ; le contrat rend simplement `itemId` absent.) Une route
d'élément porte un `item_id` numérique : une fonctionnalité dont les éléments
ont un identifiant texte n'a pas de route par élément.

Pour les émetteurs à éléments, **la sélection vit sur l'élément** : chaque cible
coche un ou plusieurs canaux de sa feature dans ses propres réglages. Il n'y a
pas de route « par défaut » dont les éléments hériteraient : cocher à l'échelle
de la feature ne viserait aucun élément nommable, et des cases grisées « suit la
fonctionnalité » semblent ne jamais pouvoir se cocher.

Un avis qui concerne plusieurs éléments à la fois (l'accès qu'ils partagent est
tombé, Déploiements) n'a pas de route à lui : il suit les canaux cochés par ces
éléments, chacun une fois (`notify.send(alert, { itemIds })`, l'union de leurs
routes). Ce n'est pas un héritage deviné, ce sont des canaux que quelqu'un a
cochés pour ces éléments-là.

Un canal `enabled = 0` ne reçoit rien (`resolveChannel` l'écarte) ; l'écran le
marque « éteint ».

---

## 3. Les trois types de canal

```
email    un compte Mail « open » de l'espace expédie vers une adresse
webhook  un POST JSON générique : `content` (Discord), `text` (Slack),
         plus les champs structurés pour un point d'entrée maison
discord  la mise en page riche (embeds, couleurs, champs) et, pour les
         déploiements, le suivi vivant : un message qui se met à jour
```

### Le courriel passe par le module Mail

`src/Services/notifications.ts` ne lit pas `mail_accounts` et ne parle pas SMTP :
tout ce qui touche à une boîte passe par le contrat que le service du module
publie, `MAIL_TRANSPORT_PROVIDER` ([Mail](../features/mail/README.md) §4) :
`listSenders` (les expéditeurs prêts, c'est-à-dire les comptes **ouverts et
actifs** de l'espace), `isReady` (ce que `ready` affiche sur un canal e-mail),
`send` (l'envoi d'un texte, `false` sur échec, jamais de levée). Un canal e-mail
résolu porte le destinataire et l'identifiant du compte expéditeur, aucun
identifiant SMTP ; une cible vide signifie « vers l'adresse de l'expéditeur
lui-même ». **Sans module Mail installé, aucun canal e-mail n'est prêt**, et
l'écran des canaux le dit plutôt que d'afficher un réglage qui ment.

### Discord est déclaré, pas deviné

Le type d'un canal est une déclaration de l'utilisateur, jamais une déduction
sur l'URL : renifler l'URL déciderait à sa place, et un point d'entrée maison
servi depuis un domaine Discord recevrait des embeds au lieu de son texte.
`isDiscordWebhook` (`src/Services/discord.ts`) ne sert qu'au **contrôle de
saisie** : un canal déclaré `discord` dont l'URL n'est pas un webhook Discord
(`https://discord.com/api/webhooks/…`) est refusé par le serveur
(`src/features/_notifications.ts`, `validate`), avec le message qui renvoie vers
« Webhook ». Toute URL de webhook doit être en `https` et passer le garde des
adresses sortantes (`isAllowedOutboundUrl`).

### Chaque émetteur porte sa mise en page

La mise en page Discord vit chez l'émetteur, dans `features/<f>/src/server/notice.ts`
(Uptime, Bases de données, Déploiements, Sauvegardes, Sentinelle), sur les
helpers de `src/Services/notices/shared.ts` : les couleurs (`COLOR_DANGER`,
`COLOR_SUCCESS`, `COLOR_INFO`, `COLOR_WARNING`), `FIELD_MAX`, `moment`,
`duration`, `trim`, `block`, `footer`. Un seul socle, importé et commenté comme
tel, pour que `duration()` dise la même chose partout : deux copies dérivent, et
une panne de trois jours se lit « 72 h » d'un côté et « 3 j » de l'autre. Un
module externe n'a pas de chemin d'import vers ce fichier et écrit ses propres
aides.

### Le suivi vivant

Un déploiement est un message Discord qui se met à jour. Avec plusieurs canaux
Discord il faut une carte canal → identifiant de message :
`deployments.content.noticeIds` (`features/deploy/src/server/_shared.ts`), parce
qu'éditer dans le second salon un identifiant qui appartient au premier n'a pas
de sens. Les canaux d'un même déploiement sont publiés **séquentiellement**,
jamais en `Promise.all` : ils écrivent tous dans le même blob. Le parallélisme
reste sur les déploiements, où est la latence.

---

## 4. Chiffrement

Tout est à l'**étage ouvert** : ce sont les boucles de fond qui relisent les
canaux, sans session ni mot de passe. Un secret rangé au palier gardé y serait
illisible et l'alerte ne partirait jamais, en silence.

`label_enc` est **nullable** : sans libellé, le serveur affiche la destination
elle-même (`fallbackLabel`), la meilleure description possible d'un canal que
personne n'a nommé.

---

## 5. Autorisation : deux étages, et ils ne se confondent pas

|                                            | Qui                                           |
| ------------------------------------------ | --------------------------------------------- |
| Déclarer, corriger, supprimer un canal     | gestion des canaux de SA feature (`channels`) |
| Lire la **liste** des canaux d'une feature | `<feature>: read`                             |
| Lire la **destination** d'un canal         | gestion des canaux de SA feature (`channels`) |
| Router une fonctionnalité vers un canal    | `<feature>: write`                            |

La gestion des canaux est **par fonctionnalité** : le champ `channels` du grant
de feature du rôle ([WORKSPACES.md](./WORKSPACES.md) §3), qui exige aussi la
lecture de la fonctionnalité (on ne gère pas les destinations de ce qu'on ne
voit pas). Il n'y a pas de capacité d'espace qui confierait d'un bloc
l'astreinte d'Uptime et le salon des sauvegardes.

La liste s'ouvre avec la lecture de sa fonctionnalité parce qu'**on ne peut pas
router vers des destinations qu'on ne voit pas**, et voir où Uptime prévient
fait partie de lire Uptime. Leur contenu, lui, reste gardé : confier le réglage
d'Uptime ne confie pas l'adresse de l'astreinte ni l'URL du salon de
production. On voit donc « Astreinte · e-mail », on peut y router, on ne peut
ni la lire ni la modifier : `describeChannel` vide `target` pour qui ne gère
pas les canaux de la fonctionnalité.

Aucune commande `notify.*` (`src/features/notify/index.ts`) n'a d'autorisation
déclarative : la fonctionnalité visée est une donnée d'entrée (l'argument
`feature`, ou celle du canal visé par son id), pas une constante de la commande.
Le contrôle est donc en première ligne de chaque handler
(`assertChannelAccess`, `assertRouteAccess` dans
`src/features/_notifications.ts`), comme pour `devices.setConfig`, et pour la
même raison.

---

## 6. Côté client

`Components/FeatureSettings/` : **une seule coquille pour les deux échelles**
(une fonctionnalité, un de ses éléments), navigation à gauche, sections à
droite ([SETTINGS.md](./SETTINGS.md)). La section Notifications est
`sections/NotificationsSection.tsx`.

Le principe qui la gouverne : **une section n'apparaît que si elle mène à
quelque chose d'utilisable, et quand il n'en reste aucune, le bouton n'existe
pas**. `FeatureSettingsButton` rend `null` : la règle tient à un seul endroit
plutôt que d'être à retenir dans chaque feature.

Points d'appel : la barre d'outils de chaque émetteur (échelle fonctionnalité)
et l'en-tête de fiche d'un service, d'une base, d'une cible, d'un travail
(échelle élément).

**La gestion des canaux ne se rend qu'à l'échelle de la fonctionnalité.** À
l'échelle d'un élément, la section ne fait que cocher, et « Gérer les canaux »
ouvre les réglages de la fonctionnalité par-dessus, sur ce même onglet. C'est le
contrat des sources ([SOURCES.md](./SOURCES.md)) : une chose réutilisable se
crée et se corrige à un seul endroit, les éléments la désignent.

Dans le formulaire d'un canal e-mail, le « + » à côté du compte expéditeur
ouvre le **vrai** dialogue de compte du module Mail (`AccountDialog`, par le
contrat client `MAIL_CLIENT_PROVIDER`), et la boîte créée est sélectionnée au
retour.

---

## 7. La façade `notify` du SDK

Un module ne voit jamais une URL de webhook ni un canal résolu : il passe par la
façade `notify` (`src/features/_sdk/facade.ts`, typée dans `src/sdk/server.ts`
de `@deveye/types`), gardée par la capacité `notify` du manifest.

```
notify.hasRoute(itemId?)                          la cible a-t-elle au moins un canal routé
notify.send(alert, { itemId | itemIds, except })  l'avis ; `false` sans canal routé
notify.liveChannels({ itemId })                   les canaux de la route qui savent modifier
                                                  un message (le type déclaré `discord`)
notify.postLive(channelId, message, id?)          publie sans identifiant, modifie avec ; rend
                                                  l'identifiant à garder, `null` si le canal refuse
```

`postLive` relit la ligne du canal pour vérifier qu'il appartient à LA feature
du module et à SON espace avant de publier quoi que ce soit : la résolution par
identifiant ignore la feature, la façade ne s'y fie pas. Un `null` dit de
s'arrêter là (message supprimé à la main, webhook révoqué), jamais de republier.
`send(alert, { itemId, except })` sert à conclure en texte, en sautant les
canaux dont le message vivant a déjà conclu.

Les émetteurs de l'app (`deliver`, `resolveRoute` dans
`src/Services/notifications.ts` ; `postMessage`, `editMessage` dans
`src/Services/discord.ts`) sont le corps de tout cela ; la façade en est la
seule porte pour un module.

---

## 8. Ajouter un émetteur

Pour un module, aucune commande, aucun handler, aucun écran à écrire :

1. **Le manifest** : `notifies: true` et `notifications.hint`, la phrase de
   tête de l'onglet Notifications qui dit **quand** la fonctionnalité prévient
   (exigée dès que `notifies` est vrai : sans elle, l'onglet liste des canaux
   sans dire à quoi ils servent) ; `notifications.perItem: false` si rien ne
   part jamais au nom d'un élément. Pour une
   fonctionnalité du dépôt, ces champs viennent du registre
   (`featureDescriptor(id)`), et `nativeNotificationFeatureSchema`
   (`src/domain/notifications.ts` de `@deveye/types`) doit lister le même id :
   le contrôle au chargement refuse le démarrage si les deux divergent. Un
   module externe n'a rien à ajouter là : `notificationFeatureSchema` admet
   tout identifiant `x-…`.
2. **La capacité** : `'notify'` dans `nativeCapabilities`. Le boot refuse un
   module qui la déclare sans `notifies: true`.
3. **La mise en page** (facultative) : `src/server/notice.ts` chez lui, qui
   construit les `embeds` de l'alerte ; un module du dépôt importe les helpers de
   `src/Services/notices/shared.ts`.
4. **L'envoi**, dans son service de fond :
   `deps.deveyeFor(workspaceId).notify.send(alert, { itemId })`, où `alert` est
   `{ subject, body, payload, embeds? }`. Il rend `false` sans canal routé, ce
   qui suffit à retenir qu'une panne n'a pas été annoncée.
5. **La suppression** : `ctx.items.forget(String(id))` dans le handler qui
   supprime l'élément. Rien ne rattache une route à son élément (pas de clé
   étrangère : la cible change de table selon la feature), et une route
   orpheline vaudrait « réglé à la main » pour le prochain élément à hériter de
   l'identifiant. `forget` retire en un geste la route, les projections et les
   restrictions ([SHARING.md](./SHARING.md) §7).

C'est ce que font Uptime (`features/uptime/src/server/service.ts`,
`handlers.ts`) et Bases de données (`features/database/src/server/service.ts`,
`crud.ts`).

---

## 9. La cible Système

`system` n'est pas une fonctionnalité : elle porte les alertes de l'instance
elle-même (erreurs serveur, plantages, redémarrages ; voir [LOGS.md](./LOGS.md)
§3). Elle entre dans `notificationFeatureSchema` à côté de l'enum natif
(`SYSTEM_NOTIFICATION_TARGET`), jamais dans `FEATURE_REGISTRY` : aucun rôle ne
la porte, et le contrôle de parité ne la voit pas.

- **Qui la règle** : un administrateur global, dans un espace qu'il possède
  (`assertManagesSystem` : `ctx.isAdmin && ctx.isOwner`, appelé par
  `assertChannelAccess` et `assertRouteAccess` quand la feature est `system`).
  Ses canaux et sa route vivent dans cet espace, avec `item_id = 0`.
- **Qui la reçoit** : `systemRouteWorkspaces()` (`src/db/repos/notificationChannels.ts`)
  rend les espaces qui ont une route système et dont le propriétaire est un
  administrateur actif. Un administrateur rétrogradé cesse d'être prévenu sans
  qu'on nettoie sa route.
- **Quand DevEye est tombé** : la page d'état garde une copie de ces
  destinations et les prévient elle-même ([STATUS_PAGE.md](./STATUS_PAGE.md)).
- **Côté client** : la coquille accepte `ShellScope` (une fonctionnalité, un
  élément ou la cible système, `Components/FeatureSettings/scope.ts`) à ses
  entrées seulement ; les sections propres aux fonctionnalités gardent
  `SettingsScope`. La page Logs porte le bouton.
