# Mail, les boîtes de l'espace

> Écrit le 28 août 2026, le jour où Mail est devenue la **treizième native
> rapatriée** sur le SDK des modules (`features/mail`,
> [FEATURE_SDK.md](./FEATURE_SDK.md)), par deux agents en parallèle (serveur +
> app, client + écrans natifs). Il dit *pourquoi* ; le code dit comment.
>
> Documents voisins : [SECURITY_MODEL.md](./SECURITY_MODEL.md) (les deux
> étages), [AUTH_PROMPTS.md](./AUTH_PROMPTS.md) (l'invite de déverrouillage),
> [NOTIFICATIONS.md](./NOTIFICATIONS.md) (le canal e-mail des alertes),
> [SHARING.md](./SHARING.md) (le partage inter-espaces, branché ici le 28 août
> 2026), [SETTINGS.md](./SETTINGS.md) (la coquille de réglages),
> [LIVE.md](./LIVE.md).

Des boîtes IMAP/SMTP lues et écrites depuis DevEye : des comptes par espace,
leurs dossiers et leurs enveloppes en cache, le corps d'un message lu en
direct, l'envoi, et le transport des alertes e-mail des autres features.

---

## 1. Le principe : deux paliers, choisis par compte

C'est ce qui distingue Mail de tout le reste. Uptime est toujours à l'étage
ouvert, le Coffre toujours à l'étage gardé ; une **boîte mail choisit son
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
  neutralisées sauf permission ou domaine approuvé), et les liens douteux
  signalés (`linkHeuristics.ts`), sans rien bloquer.
- **L'état d'une boîte s'écrit sur tous les chemins** (`runWithAccountStatus`)
  : qu'on l'ouvre, qu'on la relève à la main ou qu'on la laisse tourner, un
  accès qui tombe se voit tout de suite, et un accès qui revient efface la
  mention. Seules les transitions écrivent et se diffusent.

## 3. Les deux routes à ticket

Deux gestes ne passent pas par le socket : le navigateur **télécharge** une
pièce jointe (un GET nu, pour que `Content-Disposition` fasse son travail), et
la fenêtre de consentement OAuth **revient** de chez Google ou Microsoft. Ce
sont les deux routes publiques du module (`routes.ts`, capacité
`routes.public`, `exposure: 'app'` : l'origine de l'app seulement, jamais
l'écouteur public).

Ce qui les autorise est un **ticket de session** du SDK : la commande le
signe (`ctx.secrecy.ticket(payload, { ttlSeconds })`, deux minutes pour une
pièce jointe, dix pour un consentement), le navigateur le porte (dans l'URL,
ou dans le `state` OAuth), la route le rend (`deps.secrecy.redeem(ticket)`)
contre **les codecs de l'appelant** : l'étage ouvert toujours, l'étage gardé
tant que sa session est déverrouillée, `null` sinon. Le module ne voit ni
identifiant de session ni clé ; c'est l'hôte qui relit la session, et
l'audience du jeton porte l'identifiant du module, de sorte qu'un ticket ne se
rend qu'à celui qui l'a émis. C'était l'ex `signMailAttachmentToken` /
`signMailOAuthState` de `auth/jwt.ts`, partis avec la native.

Une pièce jointe d'une boîte gardée dont la session s'est verrouillée entre
l'émission et le clic est **refusée** (`401 locked`), pas tentée ; un retour
OAuth dans la même situation rend la page d'échec sans créer de compte. La
page de retour se referme d'elle-même et poste vers l'origine de l'app
(`deps.origins.app`, l'ex `PUBLIC_ORIGIN` que le module ne lit pas), la même
origine qui figure dans le `redirect_uri` enregistré chez le fournisseur.

## 4. Le transport des alertes

Les autres features préviennent par e-mail **depuis une boîte ouverte et active
de l'espace** (NOTIFICATIONS.md §3). Tant que Mail était native,
`Services/notifications.ts` lisait `mail_accounts` et parlait SMTP lui-même.
Depuis le rapatriement, il lit le contrat que le service du module publie,
`MAIL_TRANSPORT_PROVIDER` (`transport.ts`) : `listSenders(ws)` (les
expéditeurs prêts, libellé et adresse déchiffrés sous le codec ouvert),
`isReady(accountId, ws)` (ce que l'écran des canaux affiche), `send(accountId,
ws, { to, subject, text })` (identifiants déchiffrés sous le codec ouvert,
envoi par le client SMTP, jeton OAuth rafraîchi persisté ; `false` et une ligne
de journal sur échec, jamais de levée : l'appelant est une boucle de fond).

Sans module Mail installé, **aucun canal e-mail n'est prêt**, et l'écran le
dit ; la façade `deveye.mail.listAccounts` des autres modules lit le même
contrat et rend `[]`.

## 5. La carte du code

Côté serveur (`features/mail/src/server/`) :

- `repo.ts` : les quatre dépôts natifs (comptes, dossiers, messages,
  réglages) en un seul `MailRepo` sur `SdkQueryable`, sections gardées ;
- `_shared.ts` : `cipherFor`, `accountCipher` (le codec du domicile d'un
  compte, projeté ou non), `assertAtHome`, `assertMailUnlocked`,
  `assertTierAllowed`, `runWithAccountStatus`, les identifiants chiffrés,
  `persistRefreshedToken`, `reencryptAccountTree`, les DTO, la chaîne message
  → dossier → compte (`loadAccount` sur `findVisible`, avec
  `ctx.items.assert`), `imapFor` ;
- `accounts.ts`, `folders.ts`, `messages.ts`, `settings.ts`, agrégés par
  `handlers.ts` : les vingt-six commandes ;
- `sync.ts` (la relève d'un dossier, la réconciliation de la fenêtre récente,
  le rattrapage vers le passé, la remise à zéro ; le client IMAP en paramètre,
  `SyncClient`) et `syncStatus.ts` (l'avancement en mémoire, pour la barre) ;
- `service.ts` (`MailSync`, l'ex `Services/MailSyncService.ts` : un ticker du
  SDK, `deps.cipherFor`, `deps.live.changed` aux transitions, l'échéance par
  compte ; couture de test `{ mailClient, accountTimeoutMs }`) ;
- `transport.ts` (le contrat des alertes), `routes.ts` (les deux routes à
  ticket, couture `{ client, oauth }`), `client.ts` (IMAP/SMTP, l'ex
  `Services/MailAccountClient.ts`), `oauth.ts` (l'ex `Services/MailOAuth.ts`,
  `redirect_uri` sur `origins.app`), `parse.ts`, `sanitize.ts`,
  `linkHeuristics.ts` (l'ex `src/mail/*`), `env.ts` (`MAIL_SYNC_*`,
  `OAUTH_*`, sortis de `Utils/Env`), `index.ts` (l'entrée : `createService`
  avec le service, le provider et les routes).

Côté client (`features/mail/src/client/`) : `index.tsx` (l'entrée : le widget
de la grille, la vue complète `Mail.tsx`, les trois panneaux de réglages, le
contrat client `MAIL_CLIENT_PROVIDER` par `provider.tsx` : les expéditeurs
prêts et le dialogue de compte que le formulaire d'un canal e-mail compose),
`api.ts` (`featureApi(manifest)`), la liste et la fiche d'un compte
(`AccountList`, `AccountCard`, `AccountPanel`, `AccountPopup`,
`AccountOptions`, `SyncProgressBar`, `accountStatus.ts`), l'arbre des dossiers
(`FolderTree`), les messages (`MessageList`, `MessagePane`, `MessagePopup`,
`MessageInfoPopup`, `ImageSourcesPopup`, `ComposePopup`, `ConfirmPopup`), les
panneaux `MailGeneralPanel` (l'espace : analyse externe, domaines d'images,
mode de rendu), `MailSyncPanel` (la cadence d'une boîte, ses relèves) et
`MailEncryptionPanel` (le palier d'une boîte, `securityTier.ts`), la feuille
`style.module.css`.

Les contrats (`src/contracts/{domain,commands}.ts`) sont sortis de
`@deveye/types`, qui ne garde que l'identité de la feature et les deux
contrats de couplage (`MAIL_TRANSPORT_PROVIDER`, `MAIL_CLIENT_PROVIDER`). Les
quatre tables `mail_*` datent du socle et sont en allowlist
(`deveye-feature.json`) : aucune migration du module, aucun `uninstall.sql`.

Le manifest garde le `shareTier: 'perItem'` du descripteur publié, et le
tient : l'entrée `items` de `server/index.ts`, `listVisible` / `findVisible`
dans le dépôt, `accountCipher` dans `_shared.ts`. C'est la section suivante.

## 6. Le partage : un compte, des fenêtres

L'élément que le partage projette est le **compte** (`mail_accounts`) ; ses
dossiers et ses messages en cache le suivent, parce que la chaîne message →
dossier → compte remonte toujours jusqu'à lui (`loadAccount`, sur
`findVisible`). Un compte projeté vers un autre espace y apparaît dans la
liste avec `foreign: true`, après les comptes locaux, et le compte de la carte
d'accueil compte les mêmes lignes (SHARING.md §8 : une carte qui compte autre
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
tier)` ne sert plus qu'à la création et au changement de palier, qui n'ont
lieu qu'au domicile.

**Une fenêtre lit et agit, le domicile configure** (SHARING.md §2). Depuis
la fenêtre : lister les dossiers, lire, marquer, déplacer, supprimer un
message, envoyer, relever, rattraper, reconstruire un dossier, renommer la
boîte, régler sa cadence, la mettre en pause. Au domicile seulement, refusé
d'ici par `assertAtHome` (`validation`) et non proposé par l'écran : supprimer
la boîte, changer son palier, retoucher ses identifiants ou son proxy
(`mail.accountUpdate` en entier, `mail.accountSetProfile` dès que le palier ou
le proxy bougent), reconnecter par OAuth (supprimer puis reconnecter, donc au
domicile aussi). Le critère est celui de SHARING.md : ces gestes relient la
boîte à des objets de son espace d'origine, le mot de passe de son auteur au
premier chef.

**La relève tourne au domicile, et une fois.** `listSyncDue` lit les comptes
d'un espace, pas ce qu'on y voit : un compte projeté vers trois espaces n'est
pas relevé quatre fois. La diffusion, elle, traverse la projection : le
`deps.live.changed(domicile)` d'un tour est rejoué par l'hôte dans chaque
espace relié par `item_shares` (SHARING.md §8), sans que le service ait à
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

## 7. Les pièges

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
  pour de bon, sans erreur ni trace. Son message est classé `unreachable`
  (apostrophe droite ou typographique, les deux formes existaient).
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
