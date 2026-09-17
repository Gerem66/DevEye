# Serveur mail, des adresses hébergées par DevEye

Des boîtes mail sur les domaines de l'espace, servies par DevEye lui-même :
SMTP entrant et sortant, IMAP, DKIM et certificat, **dans le processus de
l'app**, sans conteneur ni service tiers. Ce document dit _pourquoi_ ; le code
dit comment.

Documents voisins : [Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md) (le
contrat, dont les domaines), [Docs/SETTINGS.md](../../Docs/SETTINGS.md) (la
coquille et sa section Domaines), [Docs/SHARING.md](../../Docs/SHARING.md),
[Docs/KEY_ROTATION.md](../../Docs/KEY_ROTATION.md), et
[`deploy/README.md`](../../../deploy/README.md) pour la mise en service.

## 1. Un serveur pour l'installation, des adresses pour chaque espace

Les écouteurs appartiennent au **processus** : un nom d'hôte
(`MAILSERVER_HOSTNAME`), quatre ports, un certificat. Les domaines et les
adresses appartiennent aux **espaces**. Un message entrant est routé par son
destinataire : le domaine (celui du SDK, vérifié) donne l'espace, l'adresse
donne la boîte. D'où l'adresse en clair et unique dans toute l'installation :
elle est publique par nature, et le routage n'a ni session ni clé.

Sans nom d'hôte rien n'écoute, mais le reste vit : on peut préparer domaines
et adresses avant la mise en service.

## 2. Ce qui est chiffré, et sous quoi

Tout se passe à l'étage **ouvert** : la remise d'un message arrive sans
session, l'étage gardé lui serait fermé. C'est pourquoi `shareTier` vaut
`'open'`.

- Le nom affiché, l'enveloppe et la structure d'un message (`meta`), les pairs
  du journal, la file d'envoi : scellés sous le codec ouvert de l'espace.
- Les **corps** : hors base, un fichier DEVB v2 par message sous
  `MAILSERVER_STORAGE_DIR/<boîte>/`, sous une clé propre à la boîte, elle-même
  scellée par la clé du serveur. Supprimer une boîte efface sa clé et son
  dossier. Une copie IMAP ou la file d'envoi partagent le fichier par comptage
  de références.
- Les mots de passe : **jamais en clair**. Celui de la boîte et ceux
  d'application sont hachés (scrypt) et affichés une seule fois.
- Les clés DKIM et celle du certificat : scellées par la clé du serveur, donc
  listées dans `scripts/rotate-server-key.ts`.

## 3. Le lien avec Mails

Le module ne lit pas le courrier : Mails le fait, en IMAP, comme pour n'importe
quel fournisseur. « Ajouter à Mails » crée un **mot de passe d'application**
réservé à Mails puis ouvre SON formulaire prérempli, par le contrat client
`MAIL_CLIENT_PROVIDER` (`findByAddress`, `AccountDialog` avec `prefill`) :
aucun import entre les deux modules, aucun secret conservé. Fermer le
formulaire sans enregistrer révoque le mot de passe créé.

Mails ne fait jamais d'`APPEND` : l'identifiant créé pour lui porte `save_sent`,
et c'est la soumission qui range la copie dans Envoyés.

## 4. Le serveur IMAP est écrit ici

Il n'existe pas de serveur IMAP maintenu en bibliothèque JS. Celui-ci
(`src/server/imap/`) sert IMAP4rev1 et n'annonce que ce qu'il fait :
`LITERAL+ SASL-IR AUTH=PLAIN ID NAMESPACE UIDPLUS MOVE IDLE SPECIAL-USE UNSELECT
CHILDREN`. Un client n'envoie que ce qu'il lit dans cette liste : ne pas
annoncer ENABLE, CONDSTORE ou COMPRESS suffit à ne jamais les recevoir.

- TLS implicite seulement (993). Aucune session ne commence en clair.
- `mime/tree.ts` calcule une fois, à la remise, les positions et les comptes de
  lignes que `BODYSTRUCTURE` et `BODY[1.2]` exigent : aucun analyseur de
  courrier ne les donne.
- `mailboxView.ts` tient les numéros de séquence de la session. Ce que d'autres
  font au dossier attend qu'IMAP permette de l'annoncer : tout de suite en
  IDLE, à la fin d'une commande sinon, jamais pendant un FETCH, STORE ou SEARCH
  par numéro.
- Le notifieur est en mémoire : valable parce que l'app est un seul processus.

Deux tests le tiennent : `imap/server.test.ts` le pilote avec le **vrai
imapflow**, dans la forme d'options de Mails ; `imap/transcript.test.ts` parle
le protocole à la main pour ce que font les clients de bureau. Un bogue de
compatibilité se corrige en ajoutant d'abord son échange au second.

## 5. Ne jamais devenir un relais

La réputation de l'IP est commune à tous les espaces.

- Le port 25 refuse dès `RCPT TO` tout destinataire qui n'est pas une boîte
  d'ici, et personne ne s'y authentifie.
- La soumission exige TLS avant `AUTH`, n'écrit que sous l'adresse
  authentifiée (enveloppe **et** en-tête `From`), et plafonne chaque boîte par
  heure et par jour : un mot de passe volé s'arrête là.
- La file refuse de remettre à une adresse privée : un MX ne fait pas sonder le
  réseau du serveur.
- À l'entrée, `mailauth` juge SPF, DKIM et DMARC. Un échec DMARC suit la
  politique du domaine de l'expéditeur (refus, ou dossier Indésirables).

## 6. Le certificat

Let's Encrypt, défi HTTP-01 servi par une route publique du module : il suffit
que le nom du serveur arrive jusqu'à l'app par le proxy. Une paire PEM fournie
par l'installation passe devant (un proxy qui garde le défi pour lui). Le
certificat est poussé aux écouteurs sans refermer leurs ports ; sans lui, seul
le 25 écoute, sans chiffrement.

## 7. Hors périmètre, pour l'instant

Alias et adresse attrape-tout, filtres côté serveur (Sieve), POP3, filtre
antispam de contenu, CONDSTORE et QRESYNC, MTA-STS et DANE, configuration
automatique des clients, lien avec Projets, déplacement d'une adresse entre
espaces (elle vit sur un domaine de son espace, qui ne la suivrait pas).
