# Mail, les boîtes de l'espace

Des boîtes IMAP/SMTP lues et écrites depuis DevEye : des comptes par espace,
leurs dossiers et leurs enveloppes en cache, le corps d'un message lu en
direct, l'envoi, et le transport des alertes e-mail des autres features. Ce
document dit _pourquoi_ ; le code dit comment.

Documents voisins : [Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md) (les deux
étages), [Docs/AUTH_PROMPTS.md](../../Docs/AUTH_PROMPTS.md) (l'invite de déverrouillage),
[Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md) (le canal e-mail des alertes),
[Docs/SHARING.md](../../Docs/SHARING.md) (le partage inter-espaces),
[Docs/SETTINGS.md](../../Docs/SETTINGS.md) (la coquille de réglages),
[Docs/LIVE.md](../../Docs/LIVE.md), [Docs/QUOTAS.md](../../Docs/QUOTAS.md).

---

## 1. Le principe : deux paliers, choisis par compte

C'est ce qui distingue Mail de tout le reste. Uptime est toujours à l'étage
ouvert, Mots de passe toujours à l'étage gardé ; une **boîte mail choisit son
palier** (`mail_accounts.security_tier`, une colonne en clair) :

- **`open`** : identifiants, libellé, adresse, noms de dossiers et enveloppes
  sont chiffrés sous la clé de l'espace, que le serveur sait relire seul. La
  boîte se lit sans session, se **synchronise en fond**, et peut **expédier
  des alertes** pour les autres features.
- **`guarded`** : tout cela est chiffré sous la DEK emballée par le mot de
  passe. La boîte ne se lit et ne se relève qu'en **session déverrouillée** ;
  aucun ordonnanceur ne la touche, et aucune alerte ne part d'elle.

Le palier étant une colonne en clair, le serveur choisit le codec **avant** de
lire quoi que ce soit (`cipherFor(ctx, tier)` : `ctx.cipher()` pour une boîte
ouverte, `ctx.cipher('private')` pour une boîte gardée ; et pour une boîte
projetée d'un autre espace, `accountCipher` prend le codec ouvert de son
domicile, voir §6). Changer de palier
(`mail.accountSetProfile`, `mail.accountUpdate`) rechiffre tout l'arbre du
compte, dossiers et enveloppes compris (`reencryptAccountTree`) : une ligne
qui resterait sous l'ancien codec se lirait « (verrouillé) » pour toujours.

## 2. Les invariants

- **Un secret n'est jamais rendu.** Le DTO d'un compte porte ses hôtes et ses
  ports, jamais un mot de passe, un jeton OAuth ni les identifiants d'un proxy ;
  le formulaire d'édition redemande, et un champ vide veut dire « garder ».
- **Une boîte gardée n'existe pas dans un espace partagé**
  (`assertTierAllowed`) : les deux étages y utilisent la clé de l'espace,
  lisible par tout membre, et le palier annoncerait une protection qu'il ne
  donne pas. Refus explicite, jamais retombée silencieuse sur `open`.
- **Une lecture sur une boîte gardée répond `locked` à une session scellée**
  (`assertMailUnlocked`, avant de lire) ; la liste des comptes, elle, ne lève
  pas : elle masque (« (compte verrouillé) »), pour que le compte se voie et
  se déverrouille. Le compte de la carte d'accueil répond toujours.
- **La relève de fond ne touche que les boîtes ouvertes et actives**
  (`listSyncDue` filtre en SQL, `syncOne` revérifie). Une boîte gardée se
  relève à l'ouverture (`mail.folderList`, `mail.messageList`) et au bouton
  (`mail.folderSync`).
- **Corps et pièces jointes ne sont jamais persistés.** Seules les enveloppes
  (objet, expéditeur, destinataires, date, drapeaux) sont en cache ; le corps
  est relu d'IMAP à l'ouverture, assaini côté serveur (`sanitize.ts` : ni
  script, ni gestionnaire, ni style hors mode `raw`, images distantes
  neutralisées sauf permission, domaine approuvé ou boîte qui les autorise
  toutes), et les liens douteux
  signalés (`linkHeuristics.ts`), sans rien bloquer.
- **L'état d'une boîte s'écrit sur tous les chemins** (`runWithAccountStatus`)
  : qu'on l'ouvre, qu'on la relève à la main ou qu'on la laisse tourner, un
  accès qui tombe se voit tout de suite, et un accès qui revient efface la
  mention. Seules les transitions écrivent et se diffusent.
- **Un renouvellement de jeton qui échoue n'est pas une révocation.** Seul un
  refus définitif du fournisseur (`invalid_grant`, `invalid_client`,
  `unauthorized_client`, `invalid_scope`) passe la boîte en « reconnexion
  requise » ; un délai dépassé, un 5xx, un plafond d'appels ou une passerelle
  qui répond du HTML se lisent « injoignable » et se rattrapent au tour
  suivant. C'est `OAuthTokenError.permanent` qui tranche, sur le code OAuth et
  jamais sur le statut HTTP : Google répond 400 dans les deux cas.

## 3. Les routes à ticket

Deux gestes ne passent pas par le socket : le navigateur **télécharge** une
pièce jointe (un GET nu, pour que `Content-Disposition` fasse son travail), et
la fenêtre de consentement OAuth **revient** de chez Google ou Microsoft. Ce
sont les deux routes à ticket du module (`routes.ts`, capacité
`routes.public`, `exposure: 'app'` : l'origine de l'app seulement, jamais
l'écouteur public) ; une troisième route `GET`, sans ticket, sert le script
qui referme la fenêtre de retour (`/api/mail/oauth/close.js`).

Ce qui les autorise est un **ticket de session** du SDK : la commande le
signe (`ctx.secrecy.ticket(payload, { ttlSeconds })`, deux minutes pour une
pièce jointe, dix pour un consentement), le navigateur le porte (dans l'URL,
ou dans le `state` OAuth), la route le rend (`deps.secrecy.redeem(ticket)`)
contre **les codecs de l'appelant** : l'étage ouvert toujours, l'étage gardé
tant que sa session est déverrouillée, `null` sinon. Le module ne voit ni
identifiant de session ni clé ; c'est l'hôte qui relit la session, et
l'audience du jeton porte l'identifiant du module, de sorte qu'un ticket ne se
rend qu'à celui qui l'a émis.

Une pièce jointe d'une boîte gardée dont la session s'est verrouillée entre
l'émission et le clic est **refusée** (`401 locked`), pas tentée ; un retour
OAuth dans la même situation rend la page d'échec sans créer de compte. La
page de retour se referme d'elle-même et poste vers l'origine de l'app
(`deps.origins.app`), la même origine qui figure dans le `redirect_uri`
enregistré chez le fournisseur.

## 4. Le transport des alertes

Les autres features préviennent par e-mail **depuis une boîte ouverte et active
de l'espace** ([Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md) §3).
`Services/notifications.ts` lit le contrat que le service du module publie,
`MAIL_TRANSPORT_PROVIDER` (`transport.ts`) : `listSenders(ws)` (les
expéditeurs prêts, libellé et adresse déchiffrés sous le codec ouvert),
`isReady(accountId, ws)` (ce que l'écran des canaux affiche), `send(accountId,
ws, { to, subject, text, html? })` (identifiants déchiffrés sous le codec
ouvert, envoi par le client SMTP, jeton OAuth rafraîchi persisté ; `false` et
une ligne de journal sur échec, jamais de levée : l'appelant est une boucle de
fond). Un compte mis en pause par l'offre n'est pas un expéditeur
(`deps.pauses`), pas plus qu'un compte désactivé.

Sans module Mail installé, **aucun canal e-mail n'est prêt**, et l'écran le
dit ; la façade `deveye.mail.listAccounts` des autres modules lit le même
contrat et rend `[]`.

## 5. La carte du code

Tout vit dans `features/mail/` (package `deveye-feature-mail`, installé par
`features.config.json`).

`src/manifest.ts` : le descripteur du registre (`featureDescriptor('mail')`,
dont `shareTier: 'perItem'`, l'élément est le compte), la catégorie `work`,
cinq clés de ressources (`mail.accountCount`, `mail.accountList`,
`mail.folderList`, `mail.messageList`, `mail.getSettings`) que le sujet `mail`
ravive, le sujet secondaire `mailUnread` (ouvrir un message le marque lu :
seuls les compteurs de dossiers sont à relire, `mail.messageGet` le bat),
les capacités `routes.public` et `live.publish` (l'avancement d'une relève,
poussé à la barre de progression), le stock `accounts`, les onglets de
réglages (Contenu à l'échelle de la feature ; Général, Contenu,
Synchronisation, Avancé et Chiffrement à celle d'un compte, Partage et
Permissions venant de la coquille), et les commandes.

`src/contracts/{domain,commands}.ts` : les schémas, et les vingt-sept
commandes sous le préfixe `mail.`. `@deveye/types` ne garde que l'identité de
la feature et les deux contrats de couplage (`MAIL_TRANSPORT_PROVIDER`,
`MAIL_CLIENT_PROVIDER`).

Côté serveur (`src/server/`) :

- `index.ts` : l'entrée (`env`, dépôt, handlers, `createService` avec la
  relève, le provider et les routes, l'entrée `items`, le déplacement, la
  copie, le stock de l'offre, l'export du compte) ;
- `env.ts` : `MAIL_SYNC_*`, `OAUTH_*` (§7) ;
- `repo.ts` : les quatre sections du dépôt (comptes, dossiers, messages,
  réglages) en un seul `MailRepo` sur `SdkQueryable` ;
- `_shared.ts` : `cipherFor`, `accountCipher` (le codec du domicile d'un
  compte, projeté ou non), `assertAtHome`, `assertMailUnlocked`,
  `assertTierAllowed`, `runWithAccountStatus`, les identifiants chiffrés,
  `persistRefreshedToken`, `reencryptAccountTree`, les DTO, la chaîne message
  → dossier → compte (`loadAccount` sur `findVisible`, avec
  `ctx.items.assert`), `imapFor` ;
- `accounts.ts`, `folders.ts`, `messages.ts`, `settings.ts`, agrégés par
  `handlers.ts` : les vingt-sept commandes ;
- `sync.ts` (la relève d'un dossier, la réconciliation de la fenêtre récente,
  le rattrapage vers le passé, la remise à zéro ; une première relève se borne
  aux 200 messages les plus récents d'un dossier, `INITIAL_SYNC_LIMIT` ; le
  client IMAP en paramètre, `SyncClient`) et `syncStatus.ts` (l'avancement en
  mémoire, pour la barre) ;
- `service.ts` (`MailSync` : un ticker du SDK, `deps.cipherFor`,
  `deps.live.changed` aux transitions, `deps.live.publish` pour l'avancement,
  l'échéance par compte ; couture de test `{ mailClient, accountTimeoutMs }`) ;
- `transport.ts` (le contrat des alertes), `routes.ts` (les routes à ticket,
  couture `{ client, oauth }`), `client.ts` (IMAP/SMTP), `oauth.ts`
  (`redirect_uri` sur `origins.app`, `OAuthTokenError` qui sépare un refus
  définitif d'un incident passager, renouvellements coalescés par jeton),
  `parse.ts`, `sanitize.ts`, `linkHeuristics.ts` ;
- `copy.ts` : l'arbre d'un compte (`mailTree` : le compte, ses dossiers, ses
  enveloppes), que le déplacement rescelle et que la copie emporte ;
  `move.ts` : le changement d'espace (un canal d'alerte de l'espace quitté qui
  expédiait par ce compte le perd : il faut lui rendre un expéditeur d'ici) ;
- `accountExport.ts` : l'export du compte écrit les comptes (sans
  identifiants) et les réglages ; dossiers et messages restent sur le serveur
  de messagerie, d'où la relève les relit ;
- les tests : `handlers.test.ts`, `repo.test.ts`, `service.test.ts`,
  `routes.test.ts`, `oauth.test.ts`, `client.test.ts`, `sanitize.test.ts`,
  `linkHeuristics.test.ts`, `accountExport.test.ts`.

Côté client (`src/client/`) :

- `index.tsx` : l'entrée (`MailWidget`, la vue complète `Mail.tsx`, les cinq
  panneaux de réglages, `cacheDurationMinutes: 0`, `holdSecrecy`, et le
  contrat client `MAIL_CLIENT_PROVIDER` par `provider.tsx` : les expéditeurs
  prêts et le dialogue de compte que le formulaire d'un canal e-mail ou le
  Serveur mail composent) ;
- `api.ts` (`featureApi(manifest)`), `viewState.ts` (l'état de la vue et ce
  qu'on peut y faire, décidé à un seul endroit pour les trois colonnes) et
  `EmptyState.tsx` (ce qu'affiche une colonne vide, et le geste qui en sort) ;
- la liste et la fiche d'un compte : `AccountList`, `AccountCard`,
  `AccountPanel`, `AccountPopup` (l'ajout d'une boîte, par fournisseur ou à la
  main, en étapes : `AccountSteps`), `ProviderCard` (l'état réel d'une boîte
  gérée par un fournisseur, à la place des champs de serveurs),
  `SecurityTierChoice` (le palier, à la création puis dans Chiffrement),
  `SyncProgressBar`, `accountStatus.ts` (comment se dit l'état d'une boîte,
  pastille et bandeau), `oauthWindow.ts` (l'attente de la fenêtre de
  consentement, partagée par l'ajout et la reconnexion) ;
- l'arbre des dossiers (`FolderTree`), les messages (`MessageList`,
  `MessagePane`, `MessagePopup`, `MessageInfoPopup`, `ImageSourcesPopup`,
  `ComposePopup`, `ConfirmPopup`) ;
- les panneaux : `MailAccountSettingsPanel` (Général d'un compte : son nom,
  ses serveurs, son proxy, sa suppression), `MailContentPanel` (Contenu, aux
  deux échelles : le mode de rendu des messages et les domaines dont les
  images sont approuvées ; ouvert sur une boîte, l'autorisation de toutes ses
  images, après une confirmation qui nomme le pistage), `MailSyncPanel` (la cadence de relève, de 5 à
  180 minutes, 10 par défaut, et la pause), `MailAdvancedPanel` (reconstruire
  le cache d'une boîte, écriture requise), `MailEncryptionPanel` (le palier
  d'une boîte) ;
- `MailWidget.tsx` (la carte d'accueil), `style.module.css`, et le test
  `viewState.test.ts`.

Les quatre tables `mail_*` datent du socle et sont en allowlist
(`deveye-feature.json`) : aucune migration du module, aucun `uninstall.sql`.

## 6. Le partage : un compte, des fenêtres

L'élément que le partage projette est le **compte** (`mail_accounts`) ; ses
dossiers et ses messages en cache le suivent, parce que la chaîne message →
dossier → compte remonte toujours jusqu'à lui (`loadAccount`, sur
`findVisible`). Un compte projeté vers un autre espace y apparaît dans la
liste avec `foreign: true`, après les comptes locaux, et le compte de la carte
d'accueil compte les mêmes lignes (Docs/SHARING.md §8 : une carte qui compte autre
chose que la liste qu'elle ouvre se lit comme un bug). Les restrictions par
élément s'appliquent (`ctx.items.restrictions()` sur la liste,
`ctx.items.assert(id, level)` sur chaque commande qui vise un compte).

**Le palier décide, compte par compte.** Seule une boîte **ouverte** se
projette : ses données sont chiffrées sous la clé de son espace, que le
serveur sait relire seul. Une boîte gardée est chiffrée par le mot de passe
de son auteur, illisible partout ailleurs : `items.shareable` répond `false`,
`share.set` refuse en le disant, et la coquille n'offre pas l'onglet Partage
(`shareable: false` sur la portée du bouton commun). Une boîte projetée qui
passe au palier gardé chez elle **perd ses projections** : `rekeyTier`
appelle `ctx.items.forget`, qui retire aussi les restrictions par élément, ce
qui est juste puisqu'une boîte gardée n'existe que dans un espace personnel,
où aucune restriction de rôle n'a de sens. La requête de projection ne
retient de toute façon que les comptes ouverts, en garde de cohérence.

**Le codec est celui du domicile.** Un compte projeté reste chiffré sous la
clé de son espace d'origine ; le lire avec celle d'ici le ferait passer pour
verrouillé. `accountCipher(ctx, row)` choisit : le palier du compte chez lui,
`ctx.sharing.scope().cipherFor(id)` (l'étage ouvert du domicile, le seul que
`_sharing.ts` rende) quand il est projeté. Tout ce qui lit ou écrit un compte
existant passe par là (`credentialsFor`, `imapFor`, les DTO) ; `cipherFor(ctx,
tier)` ne sert qu'à la création et au changement de palier, qui n'ont lieu
qu'au domicile.

**Une fenêtre lit et agit, le domicile configure** (Docs/SHARING.md §2). Depuis
la fenêtre : lister les dossiers, lire, marquer, déplacer, supprimer un
message, envoyer, relever, rattraper, reconstruire un dossier, renommer la
boîte, régler sa cadence, la mettre en pause. Au domicile seulement, refusé
d'ici par `assertAtHome` (`validation`) et non proposé par l'écran : supprimer
la boîte, changer son palier, retoucher ses identifiants ou son proxy
(`mail.accountUpdate` en entier, `mail.accountSetProfile` dès que le palier ou
le proxy bougent), reconnecter par OAuth (supprimer puis reconnecter, donc au
domicile aussi). Le critère est celui de Docs/SHARING.md : ces gestes relient la
boîte à des objets de son espace d'origine, le mot de passe de son auteur au
premier chef.

**La relève tourne au domicile, et une fois.** `listSyncDue` lit les comptes
d'un espace, pas ce qu'on y voit : un compte projeté vers trois espaces n'est
pas relevé quatre fois. La diffusion, elle, traverse la projection : le
`deps.live.changed(domicile)` d'un tour est rejoué par l'hôte dans chaque
espace relié par `item_shares` (Docs/SHARING.md §8), sans que le service ait à
connaître la règle ; une relève faite depuis une fenêtre (`mail.folderSync`)
écrit le cache du domicile et rafraîchit les deux côtés par `mutates`.

**Un expéditeur projeté est un expéditeur.** `MAIL_TRANSPORT_PROVIDER`
résout par `findVisible` / `listVisible` : un compte ouvert et actif projeté
dans un espace y est un expéditeur légitime des canaux e-mail de cet espace,
lu sous `deps.cipherFor(row.workspace_id)`, le codec de son domicile. La
pièce jointe d'un message d'un compte projeté se sert de même (`routes.ts` :
compte visible depuis l'espace du ticket, codec du domicile, jamais l'étage
ouvert du ticket). Le retour OAuth, lui, crée toujours le compte dans l'espace
du ticket : une boîte naît chez elle.

**Déplacer et copier** passent par l'arbre de `copy.ts` : seul un compte ouvert
voyage, et tout son arbre suit l'étage ouvert de son nouvel espace.

## 7. Configuration

Lues par `src/server/env.ts` ; les défauts sont ceux du code.

| Variable                            | Défaut | Rôle                                                                                       |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `MAIL_SYNC_TICK_SECONDS`            | `120`  | la cadence de la relève de fond, qui ne touche jamais une boîte gardée                     |
| `MAIL_SYNC_CONCURRENCY`             | `8`    | combien de boîtes se relèvent à la fois (quatre fois autant prises par tour)               |
| `MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS` | `900`  | l'échéance au-delà de laquelle la relève d'un compte est abandonnée                        |
| `OAUTH_GOOGLE_CLIENT_ID`            | vide   | l'app OAuth Google de l'installation ; vide, « Se connecter avec Google » n'est pas offert |
| `OAUTH_GOOGLE_CLIENT_SECRET`        | vide   | idem                                                                                       |
| `OAUTH_MICROSOFT_CLIENT_ID`         | vide   | l'app OAuth Microsoft 365 ; même règle                                                     |
| `OAUTH_MICROSOFT_CLIENT_SECRET`     | vide   | idem                                                                                       |

L'URI de redirection à enregistrer chez le fournisseur est
`<origine de l'app>/api/mail/oauth/callback`. L'authentification par mot de
passe ou mot de passe d'application marche sans aucune de ces variables.

## 8. Quotas et notifications

**L'offre** : `mail.accounts` est un stock qui compte les comptes des espaces
du propriétaire (Gratuite 1, Pro 10, valeurs de
`DevEye-Billing/src/server/plans.ts`). L'excédent se met en pause : un compte
en pause ne se relève plus et n'expédie plus d'alerte. Une installation sans
module de facturation n'a aucune limite.

**Notifications** : Mail ne notifie pas (`notifies: false`) ; il est le
transport des alertes des autres features (§4).

## 9. Les tests

```bash
npm run test:features
```

## 10. Les pièges

- **Le codec vient du compte, jamais de la feature ni de l'espace actif.**
  Une commande qui prendrait `ctx.cipher()` par réflexe écrirait une boîte
  gardée sous la clé de l'espace, et une qui prendrait `cipherFor(ctx,
account.security_tier)` sur un compte projeté le lirait sous la clé d'ici,
  qui ne l'ouvre pas. Tout ce qui touche un compte existant passe par
  `accountCipher(ctx, account)`.
- **Un geste réservé au domicile se refuse des deux côtés.** `assertAtHome`
  côté serveur, et l'écran ne le propose pas sur une boîte `foreign` : un
  bouton qui ouvre sur un refus est un écran qui ment.
- **`assertMailUnlocked` avant de lire, pas après.** Une boîte gardée lue à
  travers `tryDecrypt` sur une session scellée rend des dossiers sans nom et
  des enveloppes « (verrouillé) » : une réponse vide qui n'est pas vide.
- **La relève de fond diffuse aux transitions, pas à l'horloge.** Un
  `live.changed` à chaque tour ferait resolliciter la liste de tout client
  toutes les dix minutes par compte. Le débit de l'événement est celui des
  messages, plus celui d'une panne qui apparaît ou disparaît.
- **L'échéance par compte** (`MAIL_SYNC_ACCOUNT_TIMEOUT_SECONDS`) est ce qui
  rend une boîte suspendue à la rotation ; sans elle, `inFlight` la retirait
  pour de bon, sans erreur ni trace. Son message est classé `unreachable`.
- **Un écran de consentement Google en « Testing » donne des jetons de
  rafraîchissement de 7 jours.** La boîte redemande alors une reconnexion
  chaque semaine sans que rien soit cassé. L'écran doit passer « In
  production », et le scope `https://mail.google.com/` étant restreint, sa
  validation par Google conditionne la publication d'une app « External ».
- **Les identifiants d'une passe sont un objet unique et muté.** La relève de
  fond les déchiffre une fois puis passe la même référence à chaque dossier ;
  `persistRefreshedToken` écrit le jeton neuf DANS cet objet, sans quoi chaque
  dossier relirait une échéance périmée et redemanderait un jeton. Les
  commandes, elles, en déchiffrent un frais par appel.
- **Le `redirect_uri` doit être le même à l'autorisation et à l'échange** :
  `origins.app` des deux côtés, et celui enregistré chez le fournisseur. Une
  divergence est un refus opaque du fournisseur, pas une erreur de DevEye.
- **Le rendu d'un ticket lit la session côté hôte.** Un test de route pose un
  ticket du harnais (`ticket:{...}`, `unlocked` compris) ; en production le
  ticket est un JWT signé et l'étage gardé n'est tendu que si la session l'est
  encore. Ne jamais faire passer un identifiant de session par la charge.
- **Un expéditeur d'alerte est un compte ouvert ET actif.** Mettre une boîte
  en pause la retire des expéditeurs, et le canal e-mail qui la visait se dit
  « non prêt » : c'est voulu, une boîte en pause ne part pas toute seule.
