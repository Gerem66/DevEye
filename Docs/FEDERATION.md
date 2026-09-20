# Les instances distantes

Un compte peut ranger, sous ses propres espaces, ceux d'un **autre serveur
DevEye** : son instance auto-hébergée derrière un VPN, celle d'un client. Une
seule interface, plusieurs serveurs.

Le principe qui tient tout le reste : **les deux serveurs ne se parlent jamais**.
C'est le navigateur de l'utilisateur qui ouvre une seconde session sur
l'instance distante, avec le compte qu'il a là-bas, et qui porte en mémoire ce
qui passe de l'une à l'autre.

## 1. Les deux rôles

| Rôle                            | Ce que fait l'instance                                                                              | Ce qu'il faut régler                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Accueil** (d'où l'on regarde) | retient l'adresse et le libellé des instances du compte, élargit la politique de contenu de SA page | rien                                          |
| **Distante** (qu'on vient voir) | accepte qu'une page d'une autre origine y ouvre une session                                         | `FEDERATION_ORIGINS` = l'origine de l'accueil |

Le code est le même des deux côtés. Un client qui ajoute son auto-hébergée à
son compte hébergé écrit **une** valeur chez lui, l'origine de la plateforme ;
la plateforme n'écrit rien, quel que soit le nombre de clients.

`FEDERATION_ORIGINS` est une liste d'origines séparées par des virgules. `*`
les accepte toutes. Vide (le défaut), la fédération est éteinte et l'instance se
comporte exactement comme avant.

## 2. Ce que garde le serveur d'accueil : une adresse

Table `remote_instances` : `user_id`, `label`, `origin`, `sort_order`. Aucun
secret. Commandes de compte `remote.list / add / rename / remove / reorder`,
plafonnées à 5 instances par compte, `add` et `remove` audités en `warning`.

Trois garanties, à ne pas défaire :

- **Le serveur ne contacte jamais l'adresse.** Ni contrôle à l'ajout, ni sonde :
  tout part du navigateur. Sans cela, chaque compte tiendrait une requête
  sortante vers l'hôte de son choix (SSRF).
- **Rien de la session distante ne transite par lui** : ni identifiant, ni
  jeton, ni donnée.
- **La politique de contenu n'est élargie que pour le compte concerné** (§4).

## 3. La session distante : au porteur, sans cookie

Nos cookies sont `HttpOnly` et `SameSite=strict` : la page d'une autre origine ne
peut ni les lire, ni les faire envoyer. Une session fédérée voyage donc
autrement, et c'est ce qui la rend sûre : **aucune de ses requêtes ne porte
d'identifiant ambiant**. Une page tierce ne peut rien faire au nom de
l'utilisateur sans qu'il lui ait tapé son mot de passe.

Le transport se décide à l'en-tête `Origin` (`src/auth/federation.ts`) :

| Origine de la requête | Transport | Jeton d'accès           | Jeton de rafraîchissement | Défi 2FA            |
| --------------------- | --------- | ----------------------- | ------------------------- | ------------------- |
| notre page, ou aucune | `cookie`  | cookie `dv_at`          | cookie `dv_rt`            | cookie `dv_2fa`     |
| origine fédérée       | `bearer`  | `Authorization: Bearer` | corps de `/refresh`       | corps de la requête |

Les deux canaux ne se mélangent jamais : une origine fédérée n'est jamais servie
sur la foi d'un cookie (deux instances sous un même domaine parent partageraient
les leurs via `COOKIE_DOMAIN`), ni notre page sur la foi d'un en-tête. En
transport `bearer`, `login`, `2fa/challenge`, `refresh` et `change-password`
rendent les jetons dans le corps (`tokens`) et ne posent aucun cookie.

**La socket.** Un navigateur ne sait poser aucun en-tête sur une WebSocket. La
page demande donc un **ticket** (`POST /api/auth/ws-ticket`, porteur seulement)
et ouvre `/ws?ticket=…`. Le ticket finit dans une URL, donc dans des journaux :
il vit 30 secondes et ne sert qu'une fois (`src/auth/wsTicket.ts`). La poignée
de main accepte `PUBLIC_ORIGIN` sur son cookie, une origine fédérée sur son
ticket, et ferme en `4403` toute autre origine.

**CORS.** Une origine fédérée n'atteint qu'une liste fermée de chemins
(`FEDERATED_PATHS` dans `src/app.ts`) : l'état du serveur, l'auth, les routes
HTTP que le client appelle hors socket. Sans identifiants
(`credentials: false`). CORS est ici surtout **fonctionnel** : sans l'en-tête, le
navigateur refuse à la page de lire les réponses. La liste d'origines, elle, est
une défense en profondeur ; la digue est l'absence d'identifiants ambiants.

## 4. La politique de contenu, par document

`connect-src` est fermée : une page DevEye ne peut joindre que son serveur. Pour
qu'elle joigne une instance distante, la réponse qui sert **le document** porte
une politique élargie à cette seule instance (`https://hôte` et `wss://hôte`),
construite par `documentCsp()` dans `src/app.ts`.

À ce moment le jeton d'accès est souvent expiré, et le jeton de rafraîchissement
ne voyage que vers `/api/auth` : les adresses viennent donc d'un cookie à part,
`dv_fed` (`src/auth/federationCookie.ts`), reposé par `login`, `refresh` et
`me`. Il est :

- **signé** (HMAC) : un script injecté ne peut pas s'élargir la politique en le
  posant, ce qui serait son premier geste avant de faire sortir des données ;
- **`HttpOnly`**, et **`SameSite=lax`** et non `strict` : le document doit l'avoir
  même ouvert depuis un lien externe ;
- revalidé à la lecture, origine par origine (`normalizeRemoteOrigin`) : ce qui
  finit dans un en-tête CSP ne porte ni chemin, ni joker, ni point-virgule.

La politique d'un document est **figée à son chargement**. D'où le seul
rechargement de toute la fonctionnalité : juste après l'ajout d'une instance. Une
instance ajoutée depuis un autre appareil est rattrapée par l'écouteur
`securitypolicyviolation` (`stores/remoteInstances.ts`), qui recharge une fois.

La politique des comptes sans instance distante est celle de tout le monde, à
l'octet près.

## 5. Côté client

- **`api/ws.ts`** : une socket par instance, et `ws` en façade qui aiguille vers
  celle de l'espace actif. Seule la socket active se fait entendre des
  écouteurs : deux instances numérotent leurs espaces chacune depuis 1, une
  trame de l'autre passerait pour une trame d'ici. Pas de repli sur la socket
  d'ici quand celle de là-bas manque : une commande estampillée d'un espace
  distant y viserait l'espace d'ici qui porte le même numéro.
- **`api/http.ts`** : `get`/`post`/`httpFetch` suivent l'instance de l'espace
  actif ; `login`, `me`, `refresh`, `logout` et `getLocal` restent ici.
- **`stores/workspace.ts`** : l'espace actif est `{ instanceId, id }`. L'id reste
  celui que SON serveur lui donne, c'est lui que l'enveloppe porte. Tout ce qui
  se sert d'un espace comme **clé** (caches du thème et de l'accueil) passe par
  `workspaceKey`.
- **`stores/remoteInstances.ts`** : la sonde, la session, ses jetons. La session
  vit dans l'onglet. « Retenir sur cet appareil » garde le seul jeton de
  rafraîchissement dans IndexedDB (`api/remoteVault.ts`), jamais le mot de
  passe ; la déconnexion d'ici le purge. Entre onglets, la rotation du jeton se
  sérialise (`navigator.locks`) : deux onglets se passeraient sinon un jeton
  déjà tourné, que l'instance prend pour un vol et sanctionne en révoquant la
  session.
- **Qui je suis.** Dans un espace distant, on **est** le compte ouvert là-bas
  (`stores/currentUser.ts`, `acting`) : ses membres, ses droits et ses curseurs
  portent cet id. Profil, sécurité et coffre sont ceux de ce compte.
- **La page rouvre toujours ici**, puis retourne dans l'espace distant où l'on
  était si sa session a pu être reprise.

La sonde (`GET /api/status`, un `GET` nu, sans prévol) dit d'une instance si
elle est joignable, si sa fédération est ouverte, et sa version. Une instance à
une autre version mineure est grisée : ce client parlerait un autre contrat.
Le navigateur ne distingue pas « injoignable » de « refuse notre origine ».

Un espace distant ne montre que les fonctionnalités dont ce client a le code :
une tuile inconnue du catalogue est ignorée, comme une disposition plus récente.

## 6. Passer un élément d'une instance à l'autre

Partager et déplacer restent l'affaire d'un seul serveur : une projection est une
ligne de sa base, un déplacement rescelle en SQL. Entre deux instances, le geste
est **copier** ([SHARING.md](./SHARING.md) §10) : la source rend l'élément au
navigateur, qui le remet à la destination, laquelle le scelle sous sa propre clé.
Le même chemin qu'entre deux espaces d'ici, et les deux serveurs ne se parlent
toujours pas. Une instance injoignable, ou à une autre version mineure, n'est
pas proposée comme cible.

## 7. Ce que ça protège, et ce que ça ne protège pas

**Le serveur ou la base de l'accueil compromis** : il n'y trouve que l'adresse
de l'instance distante. Aucune donnée, aucun jeton, aucun identifiant.

**Le frontend de l'accueil compromis** pendant que l'utilisateur est connecté au
distant depuis lui : le JavaScript servi tient la session distante en mémoire.
C'est inhérent au fait d'ouvrir B depuis la page de A. Le sens sûr est donc
« depuis le perso » : regarder la plateforme publique depuis son instance
privée, dont la page n'est pas exposée. On ne promet jamais « tes données
auto-hébergées sont à l'abri même si nous sommes compromis ».

**La plateforme hébergée** n'est exposée à rien de nouveau par l'usage vendu
(ajouter son auto-hébergée à son compte) : `FEDERATION_ORIGINS` y reste vide, le
transport porteur, le ticket et les origines étrangères y restent refusés.

## 8. Prérequis côté navigateur

- **Contenu mixte.** Une page HTTPS ne peut ni `fetch` ni ouvrir de WebSocket
  vers du `http://`. L'instance distante doit être servie en HTTPS avec un
  certificat reconnu (Traefik et un défi DNS-01, sur un nom qui résout vers
  l'adresse du VPN). La popup d'ajout le dit avant d'enregistrer.
- **Accès au réseau local (Chrome).** Une page publique qui joint une adresse
  privée déclenche un prévol `Access-Control-Request-Private-Network`, auquel
  l'instance répond `Access-Control-Allow-Private-Network: true`, et selon la
  version une invite de permission.

## 9. En développement

La page vient de Vite, dont l'origine n'est pas `PUBLIC_ORIGIN` : `*` n'y vaut
donc rien (il prendrait notre propre page pour une instance étrangère), lister
l'origine exacte. Vite ne pose aucune politique de contenu : le rechargement
après ajout a lieu, mais rien ne serait bloqué sans lui.
