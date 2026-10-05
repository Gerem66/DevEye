# Serveur mail, des adresses hébergées par DevEye

Des boîtes mail sur les domaines de l'espace, servies par DevEye lui-même :
SMTP entrant et sortant, IMAP, DKIM et certificat, **dans le processus de
l'app**, sans conteneur ni service tiers. Ce document dit _pourquoi_ ; le code
dit comment.

**Statut.** Le module est livré avec l'app (`features.config.json`) mais reste
inerte tant que `MAILSERVER_HOSTNAME` n'est pas posé : rien n'écoute, et la
feature ne fait que ranger des domaines et des adresses ; l'onglet Général de
ses réglages le dit et nomme la variable. Il s'adresse à une installation que
l'on administre soi-même : une IP dont on tient la réputation, un PTR qui y
revient, le port 25 ouvert dans les deux sens.

Documents voisins : [Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md) (le
contrat, dont les domaines), [Docs/SETTINGS.md](../../Docs/SETTINGS.md) (la
coquille et sa section Domaines), [Docs/SHARING.md](../../Docs/SHARING.md),
[Docs/KEY_ROTATION.md](../../Docs/KEY_ROTATION.md), et le
[Quick Start](../../README.md#quick-start) du README pour l'installation.

## 1. Un serveur pour l'installation, des adresses pour chaque espace

Les écouteurs appartiennent au **processus** : un nom d'hôte
(`MAILSERVER_HOSTNAME`), quatre ports (25, 465, 587, 993 vus de l'extérieur),
un certificat. Les domaines et les adresses appartiennent aux **espaces**. Un
message entrant est routé par son destinataire : le domaine (celui du SDK,
vérifié) donne l'espace, l'adresse donne la boîte. D'où l'adresse en clair et
unique dans toute l'installation : elle est publique par nature, et le routage
n'a ni session ni clé.

Sans nom d'hôte rien n'écoute, mais le reste vit : on peut préparer domaines
et adresses avant la mise en service.

Pour chaque domaine, le module dit quoi publier (`src/server/domains.ts`) : un
MX vers le nom du serveur, un SPF `v=spf1 mx -all` (le serveur peut changer
d'IP sans que chaque domaine retouche son SPF), la clé DKIM du domaine, et un
DMARC `p=quarantine`. Il vérifie les deux enregistrements sans lesquels rien
ne marche, le MX et la clé DKIM. Retirer un domaine est refusé tant qu'une
adresse y vit.

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
  d'application sont hachés (scrypt, `src/server/passwords.ts`) et affichés
  une seule fois.
- Les clés DKIM, la clé de chaque boîte et celle du certificat : scellées par
  la clé du serveur, donc inscrites dans `SEAL_TARGETS`
  (`src/Services/sealTargets.ts` de l'app), que `scripts/rotate-server-key.ts`
  parcourt ([Docs/KEY_ROTATION.md](../../Docs/KEY_ROTATION.md)).

## 3. Le lien avec Mail

Le module ne lit pas le courrier : Mail le fait, en IMAP, comme pour n'importe
quel fournisseur. « Ajouter à Mail » crée un **mot de passe d'application**
réservé à Mail puis ouvre SON formulaire prérempli, par le contrat client
`MAIL_CLIENT_PROVIDER` (`findByAddress`, `AccountDialog` avec `prefill`) :
aucun import entre les deux modules, aucun secret conservé. Fermer le
formulaire sans enregistrer révoque le mot de passe créé. La proposition
s'affiche en haut de la fiche d'une adresse tant que Mail est installé et que
l'adresse n'y est pas ; elle se ferme pour de bon depuis l'onglet Général.

Mail ne fait jamais d'`APPEND` : l'identifiant créé pour lui porte `save_sent`,
et c'est la soumission qui range la copie dans Envoyés.

## 4. Le serveur IMAP est écrit ici

Il n'existe pas de serveur IMAP maintenu en bibliothèque JS. Celui-ci
(`src/server/imap/`) sert IMAP4rev1 et n'annonce que ce qu'il fait :
`LITERAL+ SASL-IR AUTH=PLAIN ID NAMESPACE UIDPLUS MOVE IDLE SPECIAL-USE UNSELECT
CHILDREN APPENDLIMIT=<taille maximale d'un message>`. Un client n'envoie que ce
qu'il lit dans cette liste : ne pas annoncer ENABLE, CONDSTORE ou COMPRESS
suffit à ne jamais les recevoir.

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
imapflow**, dans la forme d'options de Mail ; `imap/transcript.test.ts` parle
le protocole à la main pour ce que font les clients de bureau. Un bogue de
compatibilité se corrige en ajoutant d'abord son échange au second.

## 5. Ne jamais devenir un relais

La réputation de l'IP est commune à tous les espaces.

- Le port 25 refuse dès `RCPT TO` tout destinataire qui n'est pas une boîte
  d'ici, et personne ne s'y authentifie. Chaque adresse IP est bornée en
  connexions simultanées et par minute (`engine/limits.ts`).
- La soumission (465 en TLS direct, 587 avec STARTTLS) exige TLS avant `AUTH`,
  n'écrit que sous l'adresse authentifiée (enveloppe **et** en-tête `From`),
  et plafonne chaque boîte : cent destinataires par heure glissante
  (`smtp/submission.ts`), et un nombre de messages par jour propre à la boîte
  (`outbound_daily_limit`, réglé dans son onglet Général). Un mot de passe
  volé s'arrête là.
- La file refuse de remettre à une adresse privée : un MX ne fait pas sonder le
  réseau du serveur. Seul `MAILSERVER_ALLOW_PRIVATE_MX`, réservé aux tests,
  lève cette garde.
- Une remise qui échoue est réessayée à intervalles croissants, de cinq
  minutes à un jour, onze fois (`smtp/outbound.ts`) ; un refus définitif ou la
  série épuisée rend un avis de non-remise à l'expéditeur (`smtp/dsn.ts`,
  RFC 3464). La file se relit, se relance et s'abandonne depuis l'écran, sous
  le droit `manageQueue`.
- À l'entrée, `mailauth` juge SPF, DKIM et DMARC (`smtp/verify.ts`). Un échec
  DMARC suit la politique du domaine de l'expéditeur : refus, ou dossier
  Indésirables.

## 6. Le certificat

Let's Encrypt, défi HTTP-01 servi par une route publique du module
(`engine/acme.ts`) : il suffit que le nom du serveur arrive jusqu'à l'app par
le proxy. Une paire PEM fournie par l'installation
(`MAILSERVER_TLS_CERT_FILE`, `MAILSERVER_TLS_KEY_FILE`) passe devant, pour un
proxy qui garde le défi pour lui ; elle est relue quand les fichiers changent.
Le certificat est poussé aux écouteurs sans refermer leurs ports ; sans lui,
seul le 25 écoute, sans chiffrement, et l'onglet Général le dit.

## 7. Carte du code

Tout vit dans `features/mailserver/` (package `deveye-feature-mailserver`,
installé par `features.config.json`).

- `src/manifest.ts` : le descripteur du registre (`featureDescriptor('mailserver')`,
  `shareTier: 'open'`, l'élément est l'adresse), le lien vers Mail, la capacité
  `routes.public` (le défi ACME), le stock `addresses`, le bloc `domains`
  (sans `web` : le domaine se vérifie par ses enregistrements, pas en HTTPS),
  sept clés de ressources, le sujet secondaire `mailserverFlow` (le courrier
  qui passe, battu par le moteur sans recharger listes et réglages), le sujet
  `domain` qui ravive la liste, les onglets de réglages (Général et Domaines à
  l'échelle de la feature, Général et Accès à celle d'une adresse) et deux
  droits propres, `managePasswords` et `manageQueue`.
- `src/contracts/{domain,commands}.ts` : les schémas et les seize commandes
  sous le préfixe `mailserver.`.
- `src/server/` :
    - `index.ts` : l'entrée (dépôt, handlers, migrations, service, crochets de
      domaines, stock de l'offre, export du compte, entrée `items` sans
      `move` : une adresse vit sur un domaine de son espace, qui ne la suivrait
      pas) ;
    - `env.ts` : les variables `MAILSERVER_*` ; `repo.ts` : les dix tables
      `ft_mailserver_*` ; `handlers.ts` : les commandes ; `_shared.ts` : le
      contexte, les codecs, le moteur tendu aux commandes ; `service.ts` : le
      service (démarre le moteur, expose sa santé et ses routes publiques, ferme
      les sessions IMAP d'une adresse mise en pause par l'offre) ;
    - `domains.ts` : les enregistrements à publier et la vérification du MX et
      de la clé DKIM ; `dkim.ts` : la clé par domaine ; `folders.ts` : les
      dossiers d'une boîte neuve ; `passwords.ts` : le hachage scrypt ;
    - `engine/` : `engine.ts` (assemble tout et ouvre les ports ; sans nom
      d'hôte rien n'écoute), `mailstore.ts` (les messages, leurs dossiers, les
      corps), `blobs.ts` (les fichiers DEVB), `delivery.ts` (la remise dans une
      boîte, Indésirables compris), `auth.ts` (mot de passe de la boîte ou
      d'application), `events.ts` (le journal d'activité et les compteurs
      journaliers), `limits.ts` (bornes par IP et par boîte), `acme.ts` et
      `tls.ts` (le certificat), `health.ts` (l'état des ports pour la page
      système), `notifier.ts` (ce qu'IDLE annonce) ;
    - `smtp/` : `inbound.ts` (le port 25), `submission.ts` (465 et 587),
      `outbound.ts` (la file de remise), `verify.ts` (SPF, DKIM, DMARC),
      `dsn.ts` (l'avis de non-remise), `shared.ts` ;
    - `imap/` : `server.ts`, `session.ts`, `parser.ts`, `wire.ts`,
      `sequence.ts`, `utf7.ts`, `mailboxView.ts`, `commands/` ;
    - `mime/` : `tree.ts`, `bodystructure.ts`, `envelope.ts`, `sections.ts`,
      `words.ts` ;
    - `accountExport.ts` : ce que l'export du compte écrit des adresses et de
      leurs messages ;
    - `migrations/001_init.sql` : les dix tables ; `uninstall.sql` : leur
      suppression dans l'ordre des dépendances ;
    - `testing/` : le dépôt en mémoire et le harnais des tests.
- `src/client/` : la liste des adresses par domaine (`Mailserver.tsx`), la
  fiche d'une adresse (`AddressView.tsx`, avec son activité `ActivityChart.tsx`
  et la proposition `MailsBanner.tsx` portée par `useMailsLink.tsx`), la
  création (`CreateDialog.tsx`) et le secret montré une seule fois
  (`SecretOnceDialog.tsx`), les panneaux de réglages (`GeneralPanel.tsx`, qui
  rend `ServerPanel.tsx` à l'échelle de la feature et la boîte à celle d'une
  adresse ; `AccessPanel.tsx` pour les mots de passe d'application), la carte
  d'accueil (`MailserverWidget.tsx`), `format.ts`, `api.ts`, `index.tsx`.
- `deveye-feature.json` : aucune table en allowlist, toutes portent le
  préfixe du module.

## 8. Configuration

Lues par `src/server/env.ts` ; les défauts sont ceux du code.

| Variable                             | Défaut             | Rôle                                                                   |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------- |
| `MAILSERVER_HOSTNAME`                | vide               | le nom que les MX visent ; vide, rien n'écoute                         |
| `MAILSERVER_STORAGE_DIR`             | `/data/mailserver` | les corps des messages, un dossier par boîte                           |
| `MAILSERVER_PORT_SMTP`               | `2525`             | port d'écoute du 25 dans le conteneur                                  |
| `MAILSERVER_PORT_SUBMISSIONS`        | `4465`             | port d'écoute du 465                                                   |
| `MAILSERVER_PORT_SUBMISSION`         | `5587`             | port d'écoute du 587                                                   |
| `MAILSERVER_PORT_IMAPS`              | `9993`             | port d'écoute du 993                                                   |
| `MAILSERVER_PUBLIC_PORT_SUBMISSIONS` | `465`              | port annoncé aux clients de messagerie                                 |
| `MAILSERVER_PUBLIC_PORT_SUBMISSION`  | `587`              | idem                                                                   |
| `MAILSERVER_PUBLIC_PORT_IMAPS`       | `993`              | idem                                                                   |
| `MAILSERVER_MAX_MESSAGE_MB`          | `25`               | taille maximale d'un message, annoncée aussi par `APPENDLIMIT`         |
| `MAILSERVER_TLS_CERT_FILE`           | vide               | une paire PEM qui passe devant ACME                                    |
| `MAILSERVER_TLS_KEY_FILE`            | vide               | idem                                                                   |
| `MAILSERVER_ACME_EMAIL`              | vide               | le compte Let's Encrypt                                                |
| `MAILSERVER_ACME_DIRECTORY`          | `production`       | `staging` pour essayer sans entamer les quotas                         |
| `MAILSERVER_EVENTS_RETENTION_DAYS`   | `90`               | durée de vie du journal d'activité ; les compteurs journaliers restent |
| `MAILSERVER_OUTBOUND_IPV4_ONLY`      | `true`             | l'envoi par l'IPv4 seule, un PTR IPv6 manquant faisant refuser         |
| `MAILSERVER_ALLOW_PRIVATE_MX`        | `false`            | tests seulement : la file peut viser une adresse privée                |

Le `.env.template` de l'app documente en plus les ports publiés sur l'hôte
(`MAILSERVER_BIND_*`) et les chemins de montage (`MAILSERVER_STORAGE_ROOT`,
`MAILSERVER_TLS_ROOT`), lus par le compose seulement.

## 9. Quotas, notifications, partage

- **L'offre** : `mailserver.addresses` est un stock qui compte les adresses des
  espaces du propriétaire (Gratuite 0, Pro 5, valeurs de
  `DevEye-Billing/src/server/plans.ts`). L'excédent se met en pause : une
  adresse en pause ferme ses sessions IMAP et ne reçoit plus. Une installation
  sans module de facturation n'a aucune limite.
- **Notifications** : le module ne notifie pas (`notifies: false`) ; l'activité
  d'une adresse se lit dans sa fiche et dans le journal.
- **Partage** : `shareTier: 'open'`. Une adresse ne se projette pas et ne se
  déplace pas entre espaces : elle vit sur un domaine de son espace. L'entrée
  `items` ne sert qu'à la nommer.

## 10. Tests

```bash
npm run test:features
```

`imap/server.test.ts` et `imap/transcript.test.ts` (§4), `imap/parser.test.ts`,
`mime/mime.test.ts`, `smtp/smtp.test.ts` (réception, soumission, file et
non-remise), `engine/engine.test.ts`, `engine/blobs.test.ts`,
`engine/health.test.ts`, `passwords.test.ts`, `domains.test.ts`,
`handlers.test.ts` et `accountExport.test.ts`, tous sur le dépôt en mémoire de
`testing/`.

## 11. Ce que le module ne fait pas

Alias et adresse attrape-tout, filtres côté serveur (Sieve), POP3, filtre
antispam de contenu, CONDSTORE et QRESYNC, MTA-STS et DANE, configuration
automatique des clients, lien avec Projets, déplacement d'une adresse entre
espaces (elle vit sur un domaine de son espace, qui ne la suivrait pas).
