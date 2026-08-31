# Les espaces de travail dans DevEye

> Écrit le 6 août 2026, à la fin du chantier qui les a introduits ; relu et mis
> à jour le 21 août 2026 (rôles, partage, canaux par feature) et le 25 août 2026
> (retrait du chemin hérité « espace partagé sans clé propre »). Destiné à une
> session future : lis ce document avant de toucher aux espaces, aux rôles ou au
> chiffrement. Il dit **pourquoi** les choses sont ainsi ; le code dit comment.

---

## 1. Ce qu'est un espace

Un espace est une **instance isolée** : ses notes, mots de passe, appareils,
services surveillés, comptes mail, météo, CloudSync, son thème et la disposition
de son accueil lui appartiennent. Deux membres d'un même espace voient les mêmes
données. Basculer d'espace change tout l'écran.

Deux natures, portées par `workspaces.kind` :

|                    | `personal`             | `shared`             |
| ------------------ | ---------------------- | -------------------- |
| Combien par compte | exactement un          | autant qu'on veut    |
| Membres            | son propriétaire, seul | plusieurs            |
| Supprimable        | non                    | par son propriétaire |
| Clé de chiffrement | celle du compte        | la sienne (cf. §5)   |
| Rôles              | aucun                  | oui                  |

**Terme d'interface : « espace ».** Court, tient dans un menu, se décline
(Espace personnel, Nouvel espace, Quitter l'espace). Le code garde `workspace`.

### L'ancien `id = 0`

Avant ce chantier, l'espace personnel était **virtuel** : l'id `0`, synthétisé
dans `loadUserBundle`, jamais une ligne en base. Et surtout : les tables avaient
bien une colonne `workspace_id`, mais **aucune requête SQL ne filtrait dessus** —
chaque handler faisait `listByUser(userId)` puis un `.filter()` en JS. Deux
membres d'un même espace ne voyaient donc pas les données l'un de l'autre. Le
système était une façade.

Aujourd'hui l'espace personnel est une vraie ligne, pointée par
`users.personal_workspace_id` (NOT NULL + FK). Ce pointeur, plutôt qu'un index
unique sur `(kind, owner_user_id)` : ce dernier aurait limité chaque compte à un
seul espace _partagé_, ce qui est faux.

---

## 2. Les trois leviers d'architecture

Tout tient sur ces trois choix. Ils sont ce qui rend le système maintenable
plutôt qu'un semis de `if (workspaceId === 0)`.

### L1 — L'espace actif voyage sur l'enveloppe WS

`clientMessageSchema` porte un `workspaceId` optionnel. `ws.send` l'estampille
depuis `stores/workspace`. Conséquence : **zéro champ `workspaceId` dans les ~45
schémas d'input**, zéro passage manuel dans les ~60 sites d'appel, **un seul
point de résolution** dans le dispatcheur.

L'alternative — « espace actif mémorisé dans la session serveur » — a été
écartée : la socket se reconnecte seule (backoff, focus), et une commande émise
avant que la ré-activation n'arrive viserait le mauvais espace.

### L2 — L'autorisation est déclarative

`FeatureDefinition` porte un `access?: FeatureAccessSpec`, appliqué **par le
dispatcheur avant le handler**, exactement comme la validation zod l'est déjà :

```ts
export interface FeatureAccessSpec {
    feature?: WorkspaceFeatureId;
    level?: FeatureAccess; // défaut 'read'
    capabilities?: WorkspaceCapability[];
    admin?: true; // flotte / pages système
    scope?: 'account'; // force l'espace personnel de l'appelant
}
```

`scope: 'account'` est essentiel : pour `secrecy.*`, `twofa.*`, le changement de
mot de passe, le dispatcheur **force** `ctx.workspace` à l'espace personnel de
l'appelant quelle que soit l'enveloppe. Sans lui, une enveloppe pointant un
espace partagé pourrait détourner `secrecy.enable`.

### L3 — Chaque espace a sa clé, et un blob n'en change jamais

Un espace partagé a sa propre clé de données (WDK), posée à sa création ; un
espace personnel utilise les DEK de son propriétaire, qui en est le seul membre
(cf. §5). Un contenu est chiffré sous la clé de son espace et n'en change
jamais : déplacer un élément d'un espace à un autre est hors périmètre (§10), et
partager le projette sans le re-chiffrer (`SHARING.md`). Seul le passage d'un
étage à l'autre, à l'intérieur d'un espace personnel, re-chiffre (projets,
comptes mail, notes privées). C'est le principal réducteur de risque du
chantier. Ne pas le brader.

---

## 3. Rôles et permissions

Deux dimensions **orthogonales**, volontairement.

**Capacités** — enum fermé et court, sur la _gouvernance_ :

```
workspace.manage      renommer, logo, supprimer
workspace.members     ajouter par adresse, exclure, attribuer un rôle
workspace.roles       créer, modifier, supprimer, ordonner les rôles
workspace.appearance  thème de l'espace
workspace.layout      disposition de l'accueil
```

Il y a eu une sixième capacité, `workspace.notifications` (chantier 087) :
depuis que chaque émetteur possède ses canaux (091), elle confiait d'un bloc
l'astreinte d'Uptime et le salon des sauvegardes, et elle est devenue le champ
`channels` du **grant de feature** (migration 093) : gérer les canaux d'une
fonctionnalité se confie fonctionnalité par fonctionnalité. La liste des canaux
reste lisible avec la fonctionnalité (on ne route pas vers ce qu'on ne voit
pas), leur **contenu** ne l'est qu'avec ce champ. Voir
`NOTIFICATIONS.md`.

**Droits par feature** — map uniforme `feature → read | write` (plus le champ
`channels` ci-dessus), absent = aucun accès. Dix-sept entrées au 31 août 2026
(`workspaceFeatureIdSchema`), de `devices` à `cve` ; `monitoring` n'en est
pas une : la carte d'agrégat du même nom est réservée à l'administrateur
global dans son espace personnel.

> Une nouvelle feature coûte **une entrée dans un tableau const** et hérite du
> gating lecture/écriture sans toucher ni l'enum ni un handler.

Tableau de paires plutôt que `z.record` : en **zod 4.4.3**, `z.record(enum, v)`
est exhaustif et exigerait toutes les clés.

`devices.view` / `devices.manage` sont exprimés comme `devices: read|write`
plutôt que comme capacités — un seul mécanisme, et ça évite le double-gate où
Monitoring exigerait à la fois un droit feature et une capacité.

### Résolution, dans l'ordre

1. **non-membre** → `forbidden`. L'appartenance est la frontière, sans exception :
   même un admin global n'entre pas dans l'espace d'autrui.
2. **propriétaire** → tout, non révocable, **sans ligne de rôle**. Lui en donner
   une laisserait croire qu'on peut le lui retirer.
3. **membre avec rôle** → exactement ce que son rôle accorde.
4. **membre sans rôle** → rien. _Fail-closed_ : un oubli d'attribution retire
   l'accès, il ne le donne jamais.

### Le quatrième étage : les restrictions par élément

Un étage de **droits fins par geste** a existé (chantier 088 :
`deploy.trigger`, le terminal SQL…) puis a été **retiré** sur retour d'usage :
la granularité utile est celle des espaces et celle des éléments, pas celle des
verbes, d'où le trou dans la numérotation des migrations. Le quatrième étage
réel est `item_role_grants` : ce qu'un rôle voit d'une ligne précise (masquée,
ou en lecture seule), réglé dans les réglages de l'élément. Un grant de feature
peut en revanche porter un **réglage** de la fonctionnalité (le champ
`channels`, 093) : les verbes restent bannis, pas les réglages. Voir
`PERMISSIONS.md`, qui acte la frontière.

Deux contrôles au démarrage, qui **refusent le boot** : aucune commande sans
`access` déclaré (77 en manquaient — `uptime`, `mail`, `weather`, `cloudSync` —
et l'interface qui masquait la donnée faisait croire à une garde), et un
catalogue dont la migration de reprise dit la même chose.

> ### Piège évité, à ne pas réintroduire
>
> Les droits d'un rôle ne sont **jamais intersectés avec `workspaces.features`**.
> Cette colonne dit quels widgets figurent sur l'accueil, pas qui a le droit
> d'ouvrir quoi. L'intersecter reviendrait à supprimer l'accès à des données en
> décochant un widget — et sur les espaces existants, dont la liste contient des
> identifiants hérités (`servicemonitor`, `projects`, `airfrance2`), elle
> **verrouillerait le propriétaire hors de ses propres données**.

### L'admin global

Il ne bypass que les pages système (Logs, Utilisateurs). Les appareils n'en
relèvent plus : un appareil habite l'espace où il a été appairé, tout ce qui le
concerne tient au droit `devices` de cet espace, et `authorizeDevice` ne connaît
aucune dérogation. Un administrateur ne voit d'un espace où il n'entre pas ni
ses appareils ni le reste.
Il n'accède **pas** aux mots de passe ni aux notes d'autrui — ce serait
contredire `SECURITY_MODEL.md`, et c'est de toute façon
mécaniquement impossible sur un espace personnel chiffré par mot de passe.

### Révocation immédiate

`_access.ts` mémoïse les scopes par connexion, invalidés par un compteur
`accessEpoch` global bumpé à chaque mutation de membre/rôle/statut. Pas de timer,
pas d'attente. **Appelle `invalidateAccess()` après toute mutation d'accès.**

---

## 4. Membres

On rejoint un espace **parce qu'un membre vous y met**, en désignant votre
adresse — `workspace.addMember`. Immédiat, sans acceptation, avec le rôle par
défaut de l'espace — et immédiat aussi **chez l'intéressé** s'il est connecté :
le hub le vise par compte (`userChanged`, voir `LIVE.md`), puisqu'assis dans un
autre espace il ne recevrait pas la diffusion de celui-ci. Même voie au retrait
et à la suppression d'un espace.

Il y a eu un système de liens d'invitation (`workspace_invites`, cinq commandes,
un écran `/invite/<token>`). **Il a été entièrement supprimé** (migration 058).
Raison : l'inscription est déjà sur invitation d'un administrateur, donc tout
compte candidat existe et une adresse suffit à le désigner. Le jeton n'ajoutait
qu'un secret transmissible, à expirer et à révoquer, pour le même résultat.

Ne pas confondre avec les **invitations de compte** (`user_invites`, page admin
« Utilisateurs », URL `/register/<token>`) : celles-là existent toujours et
créent un compte DevEye. Deux systèmes distincts, deux URL distinctes.

Une adresse sans compte est refusée explicitement (« Aucun compte DevEye avec
cette adresse ») plutôt que de créer le compte : l'inscription reste la
prérogative d'un administrateur.

---

## 5. Chiffrement — la partie à comprendre avant de toucher

### Le modèle

- **Espace personnel** → la DEK du compte. Si le chiffrement par mot de passe est
  actif, elle est emballée par ce mot de passe et le serveur ne peut rien lire.
- **Espace partagé** → sa propre clé (WDK, table `workspace_secret_keys`),
  **toujours emballée par la clé serveur**. Tout membre lit l'espace sans aucun
  mot de passe, le rôle étant la seule frontière. Les tâches de fond y travaillent
  sans session.

**Tout espace partagé naît avec sa clé** : `add.ts` appelle
`createWorkspaceDek()` à la création, et c'est le seul endroit qui en pose une.
Un espace partagé sans clé n'est pas un état : `resolveWorkspaceDek()` le
traite comme un invariant rompu.

Le prix, à assumer et à dire : **le serveur peut lire le contenu d'un espace
partagé.** C'est inévitable dès lors que tous les membres doivent y accéder sans
secret partagé entre eux.

### Deux étages de chiffrement

`ctx.secure` (gardé) et `ctx.secure.open` (ouvert) — les notes et Uptime écrivent
dans l'étage ouvert, le coffre dans l'étage gardé. Dans un espace partagé la
distinction disparaît : la WDK sert les deux.

### Notes privées

`notes.is_private` perd son fondement cryptographique dans un espace partagé :
les deux étages y utilisent la même clé, donc une note « privée » serait lisible
par tout membre ayant `notes: read`. **Le bouton est donc refusé côté serveur**
(`assertPrivateAllowed`) : une note privée n'existe que dans l'espace personnel.
Garder le drapeau comme simple ACL aurait contredit le modèle documenté.

### Mail — un seul palier en espace partagé

`mail_accounts.security_tier = 'guarded'` n'a pas de sens dans un espace
partagé : les deux étages y utilisent la WDK, le palier annoncerait une
protection qu'il ne donne pas. Depuis le 26 août 2026 le serveur le refuse
(`assertTierAllowed`, même règle que les notes privées et les projets
confidentiels), le client ne propose que « ouvert » hors espace personnel, et
la migration `097` a ramené à `'open'` les comptes qui l'auraient porté (sans
rien re-chiffrer : sous la WDK, les deux paliers lisent le même octet).

---

## 6. Côté client

- **`stores/workspace.ts`** — singleton + `useSyncExternalStore`.
  `getActiveWorkspaceId()` (lu par `ws.send`), `useActiveWorkspace()`,
  `setActiveWorkspace()`, `resetWorkspace()`, `useWorkspacePermissions()`.
- **Thème et disposition par espace** — clés `deveye:theme:<id>` /
  `deveye:homeLayout:<id>`, plus `deveye:activeWorkspace` écrite
  **synchroniquement** pour qu'il n'y ait aucun flash au premier paint. Corrige
  au passage un bug antérieur : ni le thème ni la disposition n'étaient remis à
  zéro à la déconnexion, si bien qu'un second compte sur la même machine héritait
  de l'apparence du précédent.
- **Re-fetch au changement d'espace** — l'epoch d'espace entre dans la clé de la
  couche keep-alive de l'accueil, donc **tout remonte**. Zéro code par feature ;
  l'alternative (un `useEffect` par feature) est une souscription à maintenir à
  la main qu'une nouvelle feature oubliera.
- **La vue ouverte survit à la bascule** quand l'accueil de la cible propose la
  même tuile et que le rôle l'ouvre — son contenu, lui, repart de zéro par
  l'epoch ci-dessus. Sinon elle se referme.
    > **L'identité de morphe (`layoutId`) est préfixée par l'epoch d'espace**, et
    > celle de la popup est figée à son ouverture. Sans ça la bascule cassait
    > l'affichage : la disposition remplacée démonte puis remonte toutes les tuiles
    > (les sections sont clés par `section.id`, qui diffère d'un espace à l'autre),
    > la nouvelle tuile reparaît avec le `layoutId` de la popup ouverte, et
    > framer-motion — qui n'admet qu'un élément par identité — projette la popup
    > **dans** la tuile. Mesuré : 1143×743 → 290×206, sans jamais se refermer côté
    > React, d'où un fond assombri qui restait. Après une bascule la popup n'a donc
    > plus de partenaire et se referme par un fondu, ce qui est de toute façon plus
    > juste : sa carte d'origine n'existe plus. La composition de l'accueil d'un
    > autre espace n'étant **pas** embarquée dans la session, la décision ne peut
    > tomber qu'après `workspace.activate` : le contenu est donc démonté le temps de
    > la bascule, faute de quoi il interrogerait le nouvel espace avec les droits de
    > l'ancien. Les vues sans tuile (profil, sécurité, journaux, gestion de l'espace)
    > échappent à la règle : elles ne sont pas composées dans l'accueil.
- **Menu de la topbar** — section « Espaces » **en tête** (elle dit où l'on est,
  et tout ce qui suit en dépend), création via un « + » sur l'intitulé.
- **Bouton de profil** — `pseudo · Nom de l'espace`, uniquement pour les espaces
  partagés : répéter « Espace personnel » à qui y est déjà n'apprend rien.
- **En-tête de l'accueil** :

    |           | Titre            | Sous-titre                                    |
    | --------- | ---------------- | --------------------------------------------- |
    | Personnel | `Bonsoir, Gerem` | `Mercredi 5 août`                             |
    | Partagé   | `Studio Design`  | `Bonsoir Gerem · 3 membres · mercredi 5 août` |

### Gating des features non accordées

**Une seule garde, dans `handleExpand`** (`Pages/Home/index.tsx`) : la tuile de
l'accueil, la navigation entre features et le menu de la topbar y aboutissent
tous. La poser dans le rendu des tuiles ne fermerait qu'une porte sur trois.

Refus → popup « Accès refusé » nommant la feature. Sur l'accueil, la tuile reste
posée mais désaturée (`.lockedTile`) et son contenu vivant cède la place à
« Accès restreint » — sinon elle interroge un serveur qui refuse et affiche des
zéros qui se lisent comme des données. La retirer déplacerait ses voisines et
donnerait à lire une disposition abîmée. Pendant une **bascule d'espace**, ce
grisage est suspendu le temps de l'aller-retour (et le clic avec) : les droits
remis à zéro ne sont ceux de personne, et la grille reste affichée telle quelle
pour que les tuiles communes aux deux espaces glissent vers leur nouvelle place.

`featureBehind(viewId)` fait la correspondance vue → feature. Les vues de compte
et d'administration (profil, sécurité, logs, utilisateurs, gestion de l'espace)
n'en dépendent d'aucune : elles ont leurs propres gardes.

---

## 7. Base de données

| #       | Fichier                                                                      | Contenu                                                                                          |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 046     | `workspace_kind`                                                             | `kind`, `owner_user_id`, `theme`, `home_layout` ; un espace personnel par compte                 |
| 047     | `users_workspace_pointer`                                                    | `personal_workspace_id`, favori, `status` ; drop de `features`/`theme`/`home_layout` sur `users` |
| 048     | `scope_notes_passwords`                                                      |                                                                                                  |
| 049–053 | `scope_uptime`, `scope_mail`, `scope_weather`, `scope_sync`, `scope_devices` |                                                                                                  |
| 054     | `workspace_invites`                                                          | _(table supprimée depuis par 058 ; pose `uniq_workspace_member`, qui reste)_                     |
| 055     | `workspace_secret_keys`                                                      | la WDK                                                                                           |
| 056     | `workspace_roles`                                                            | rôles + `members.role_id`                                                                        |
| 057     | `user_invites`                                                               | invitations **de compte** — toujours en service                                                  |
| 058     | `drop_workspace_invites`                                                     | fin des invitations d'espace                                                                     |
| 087     | `notification_channels`                                                      | les canaux d'alerte deviennent des objets d'espace ; `notification_settings` supprimée           |

La suite du chantier est documentée ailleurs : 089 partage d'éléments entre
espaces (`SHARING.md`), 090–092 routes de notification par élément
(`NOTIFICATIONS.md`), 093 canaux par feature dans les rôles (`PERMISSIONS.md`),
094 chiffrement des sauvegardes par travail (`features/backup/README.md`). Le trou 088 est le
chantier des droits fins, retiré (§3).

### Contrainte impérative sur les migrations

`migrate.ts` exécute chaque fichier en **une** requête multi-statements, **sans
transaction**. Si le 3ᵉ statement sur 6 échoue, les deux premiers sont committés
et la migration n'est pas enregistrée : au boot suivant elle rejoue depuis le
début, échoue en doublon, et **bloque définitivement le démarrage**.

`038_uptime_order.sql` documente que `ADD COLUMN IF NOT EXISTS` (syntaxe
MariaDB) **a fait tomber la production**. Donc, sans exception :

- tout `ADD COLUMN` passe par le motif `INFORMATION_SCHEMA` + `PREPARE`/`EXECUTE` ;
- `CREATE TABLE IF NOT EXISTS` partout ;
- tout backfill porte un `WHERE <pas encore fait>`, tout `INSERT … SELECT` un
  `WHERE NOT EXISTS` ;
- fichiers courts et mono-objet.

### Rejeu obligatoire avant livraison

Toute migration se rejoue **sur une copie du dump de production** avant d'être
livrée, deux fois, en vérifiant des **invariants de données** — pas seulement le
succès du DDL. Cette méthode a attrapé de vrais bugs, dont une migration qui
aurait planté en production (`workspace_members.roles`, JSON NOT NULL, devait
être supprimée _avant_ l'insertion des adhésions).

```bash
mysql … -e "DROP DATABASE IF EXISTS DevEye_migtest; CREATE DATABASE DevEye_migtest …"
mysql … DevEye_migtest < ../Backups/<dump>.sql
DB_DATABASE=DevEye_migtest LISTEN_PORT=3099 npx tsx index.ts   # ×2
# puis : COUNT des mots de passe (308), adhésions, index conservés, orphelins à 0
```

---

## 8. Pièges rencontrés, et ce qu'ils ont coûté

- **Renommage TS ≠ renommage SQL.** Un renommage en masse a changé les
  identifiants TypeScript sans toucher les chaînes SQL : `weather_provider_keys`
  a planté franchement, **`weather_locations` a silencieusement renvoyé les
  mauvaises lignes**. Le test était trop faible ; il a été remplacé par un
  aller-retour écriture/lecture **entre deux espaces**.
- **`SelectInput` et `TextInput` posent `width: 100%`.** Dans une ligne flex sans
  contrainte, ils réclament toute la largeur et écrasent le texte voisin jusqu'à
  zéro. **Le motif est apparu trois fois** (dialogue de rôle, page Utilisateurs,
  liste des membres). À traiter à la source si l'occasion se présente.
- **`ws.send` rejetait avant l'ouverture de la socket.** Un composant monté au
  premier rendu encaissait un `closed` que l'appelant présentait comme un échec
  métier — un lien d'invitation parfaitement valide s'affichait « invalide ».
  Corrigé par une file vidée à l'ouverture.
- **Suspendre ne coupait pas les sessions vivantes.** La socket ne s'authentifie
  qu'à la poignée de main. Trois verrous désormais : `_access.ts`, `revokeUser()`
  sur les jetons, `loadUserBundle` qui ne rend plus de bundle.
- **`pruneMissingDevices`** se déclenche dès `devicesLoading === false` : après un
  changement d'espace, le store détient brièvement les appareils du **précédent**
  alors que la nouvelle disposition est active → suppression définitive de tuiles.
  Le prune est gardé sur l'estampille d'espace du store.
- **`resolveChannels` (UptimeMonitor)** joint uptime → compte mail. Aucune FK ne
  peut exprimer « même espace » : double garde, à l'écriture _et_ à la lecture.
- **Un serveur de test orphelin sur le port 3099** a servi du code périmé et
  invalidé des résultats en silence. Toujours tuer le port avant de relancer.
- **Le serveur indexe les assets statiques au boot** : un `npm run build` pendant
  qu'il tourne fait tomber les nouveaux hashs dans le fallback SPA → page
  blanche. Redémarrer.
- **`pkill -f 'remote-debugging-port=9222'` tue la session de l'agent** (le motif
  matche sa propre ligne de commande). Utiliser `lsof -ti:9222 | xargs kill`.
- **Le serveur de test rate-limit `/`** au bout de quelques rechargements
  rapides, et renvoie une page blanche trompeuse. Boucler sur la présence réelle
  du contenu.

---

## 9. Conventions du dépôt

- **Trois dépôts** : `DevEye/` (serveur + client), `DevEye-Types/`, et un miroir
  dans `DevEye/node_modules/@deveye/types/`. Après **toute** modification des
  contrats :
    ```bash
    rsync -a --delete DevEye-Types/src/ DevEye/node_modules/@deveye/types/src/
    diff -rq DevEye-Types/src DevEye/node_modules/@deveye/types/src   # doit être vide
    ```
- **`./ci.sh`** à la racine : lint + typecheck des trois, tests du serveur,
  build du client.
- **`npm run gen:css-types`** dans `client/` après toute nouvelle classe CSS —
  les `.css.d.ts` sont gitignorés mais le typecheck en dépend.
- **Pas de rétrocompatibilité.** Jamais de shim pour d'anciennes données : une
  migration SQL, ou une remise à zéro manuelle.
- **Commits directement sur la branche de travail courante**, jamais de
  branche par tâche (le tronc a longtemps été `main` ; le chantier
  d'unification vit sur `feat/unification-reglages` en attendant sa poussée).
- **Vérifier à l'écran.** Sur toute question d'interface, piloter un vrai
  navigateur (protocole DevTools ; Playwright et `chromium-cli` ne sont pas
  installés) et **regarder la capture**. Cette méthode a démenti au moins une de
  mes hypothèses : les pastilles de statut de la page Utilisateurs étaient
  centrées au pixel près, le vrai coupable était la colonne de texte à zéro.

---

## 10. Reste à faire

- [ ] Rejouer les migrations en attente sur une copie du dump de production
      avant livraison ; au 21 août 2026 : **086 à 094** (091–093 réécrivent
      des données, routes de notification et JSON des rôles).
- [x] ~~Trois migrations mail sans fichier~~ Réglé le 26 août 2026 : une base
      neuve migrée depuis le dépôt a été comparée colonne à colonne à la base
      historique. Quatre noms fantômes (`041_mail_settings_extra`,
      `042_mail_sync_interval`, `043_mail_folder_backfill`,
      `044_mail_account_sync_interval`), trois écarts réels
      (`mail_folders.first_seen_uid` INT contre BIGINT,
      `mail_settings.default_send_account_id` et `workspace_roles.permissions`
      jamais lus) : la migration `097` fait converger l'historique.
- [x] ~~Interdire `guarded` sur un compte mail d'espace partagé~~ Fait le
      26 août 2026 (cf. §5).
- [ ] Sept comptes de test (`sectest_*`, `rep_*`) traînent en base, chacun avec
      son espace personnel. Sans gravité, candidats au ménage.
- [ ] Tables mortes, `DROP` sur décision (destructif, sauvegarde d'abord) :
      dix tables de l'ère PHP importées le 30 mars 2026, qu'aucun code ne lit
      (`Users`, `Workspaces`, `WorkspaceMembers`, `Logs`, `Services`,
      `ServiceHistory`, `_Mails`, `_Notes`, `_Passwords`, `_Projects`), et
      `uptime_settings` (037, 040, 049), remplacée par les réglages par
      service. La colonne héritée `workspaces.features` contient encore de
      vieux identifiants : la laisser, rien ne la lit (§6).

### Hors périmètre, décidé

**Déplacer un élément d'un espace à un autre.** C'est la seule opération qui
exigerait un déchiffrement clé A + re-chiffrement clé B sous session vivante —
tout le reste du système est sans re-chiffrement (L3). Mérite son propre design.

> **Le partage, lui, a été fait** (chantier 089) — et il ne contredit pas ce qui
> précède. Un élément projeté vers un autre espace garde **un seul domicile** :
> il y reste chiffré, et se lit ailleurs avec le codec ouvert de cet espace-là.
> Projection, pas transfert ; rien n'est re-chiffré. Le prix est que seul
> l'étage ouvert peut voyager. Voir `SHARING.md`.

**Verrouiller un espace partagé derrière une phrase de passe partagée.** Évoqué,
non implémenté. Ce n'est pas un réglage à retourner : il faudrait décider qui
détient le secret, comment on l'ajoute à un nouveau membre, ce qu'il advient
quand on l'exclut.
