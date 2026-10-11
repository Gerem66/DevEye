# Liens courts : raccourcir, rediriger, compter

Un long lien devient une adresse courte qui redirige vers lui et compte qui
passe par là : combien de personnes, d'où elles viennent, avec quel appareil,
et comment cela évolue dans le temps. Un lien se règle (mot de passe, date de
fin, nombre de visites, destination par appareil, paramètres de campagne), se
partage en QR code, et se sert sur l'adresse de DevEye ou sur un domaine à soi.
C'est une feature de grille (carte d'accueil + panneau) avec un onglet de
modération dans l'administration des fonctionnalités.

Documents voisins : [Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md) (les noms
servis en entier et le pays d'un visiteur), [Docs/SHARING.md](../../Docs/SHARING.md),
[Docs/NOTIFICATIONS.md](../../Docs/NOTIFICATIONS.md), [Docs/QUOTAS.md](../../Docs/QUOTAS.md),
[Docs/DEBUG.md](../../Docs/DEBUG.md).

## Le modèle

Un **lien** appartient à un espace. Il porte :

- un **code** de six caractères tiré au sort (minuscules et chiffres, sans
  `0 o 1 l i` pour se recopier depuis une affiche sans hésiter), unique sur
  toute l'instance : son adresse sur DevEye ;
- facultativement, un **domaine de l'espace** et un **alias** libre sur ce
  domaine (`go.client.fr/promo`, alias vide = la racine du domaine) ;
- un contenu scellé à l'étage ouvert : titre, destination commune,
  destinations iPhone et Android facultatives, paramètres de campagne ;
- ses réglages d'accès en clair : mot de passe haché, date de fin, nombre de
  visites avant expiration ;
- son état : actif ou coupé par son auteur, retiré par l'administration,
  vérifié ou non par le contrôle de sa destination.

Le contenu est à l'étage ouvert, et la feature entière (`shareTier: 'open'`) :
une redirection lit sa destination sans session, avec la seule clé que le
serveur sait ouvrir.

**Pas d'alias sur l'adresse partagée de DevEye.** Le nom commun appartient à
toute l'instance : un alias libre y permettrait d'usurper un nom
(`/l/paypal-connexion`) ou d'en squatter un. L'alias n'existe que sur un
domaine à soi, que son propriétaire a prouvé tenir.

### Une visite, une ouverture, un robot

- Une **ouverture** : chaque passage d'une personne sur le lien.
- Une **visite** : une personne, par lien et par jour UTC. C'est ce que montre
  le graphique en premier, ce que compte la limite de l'offre et ce que compte
  « expire après N visites ». Recharger deux cents fois une page ne vide donc
  pas la limite d'un autre.
- Un **robot** (aperçu Slack, Facebook, moteur de recherche, tout ce qui
  s'annonce comme tel) est redirigé, pour que l'aperçu du message montre la
  destination, mais ne compte ni comme visite ni comme ouverture : il a sa
  propre colonne.

Une requête `HEAD` est redirigée sans rien compter.

## Les adresses

| Où                                  | Adresse                       | Route                                          |
| ----------------------------------- | ----------------------------- | ---------------------------------------------- |
| Domaine court (`SHORTLINKS_ORIGIN`) | `<domaine court>/<code>`      | `hostRequest` sur l'hôte propre (`ownHosts`)   |
| Sans domaine court                  | `<origine publique>/l/<code>` | `publicRoutes`, `/l/:code`                     |
| Domaine de l'espace                 | `https://<domaine>/<alias>`   | `hostRequest` sur un domaine vérifié du module |

L'adresse que l'interface donne est celle du domaine quand le lien en a une
qui répond, sinon celle du domaine court, sinon celle sous `/l/`.

**Un seul nom de DevEye redirige** (`redirectHost`) : le domaine court quand il
est posé, sinon l'adresse publique, jamais l'app. Celui qui diffuse un lien
choisit l'adresse qu'il diffuse : si plusieurs noms de DevEye redirigeaient, un
lien de hameçonnage passerait par le plus crédible, et c'est lui que les
navigateurs marqueraient. Le domaine court posé, `/l/<code>` ne répond plus que
sous lui : un domaine court se pose donc avant que des liens ne circulent sous
l'adresse publique.

**Le domaine court est un nom à part**, ni l'app ni sa surface publique : un
lien abusif ne fait marquer que lui, et l'app et les pages des clients n'en
souffrent pas. L'hôte le réserve comme ses propres noms : aucun espace ne peut
le déclarer, et le proxy des domaines ne le route pas.

**Un écouteur à lui** (`SHORTLINKS_LISTEN_PORT`, `FeatureService.ownListener`).
Avec un port propre, l'hôte ouvre un troisième écouteur qui ne porte que les
liens : aucune de leurs routes ne reste sur les ports de l'app et de la surface
publique, et rien de DevEye ne répond sur le leur, pas même la sonde de
vivacité. Le domaine court se route vers ce port (voir `deploy/README.md`), et
le proxy y envoie aussi les domaines des espaces qui servent des liens. Leurs
enregistrements DNS pointent alors vers le domaine court. Un nom déclaré par une
autre fonctionnalité ne peut plus l'être pour les liens : il n'irait qu'à un
seul écouteur. Sans port propre, les liens restent sur la surface publique.

Sous ces trois formes :

- `<adresse>+` : l'**aperçu**, qui montre où mène le lien sans y aller (jamais
  la destination d'un lien protégé), avec « Ouvrir le lien » et « Signaler ce
  lien » ;
- `/l/<code>/deverrouiller` : le formulaire du mot de passe poste ici ;
- `/l/<code>/signaler` : le signalement (voir plus bas) ;
- `/.well-known/deveye-shortlinks` : la preuve qu'un domaine pointe sur cette
  installation.

À la racine du domaine court, le visiteur part vers le site vitrine
(`SITE_URL`), ou voit une page neutre sans lui.

## La redirection

`server/redirect.ts`, dans cet ordre :

1. la ligne du lien, gardée en mémoire trente secondes (négatifs compris,
   bornée), oubliée à chaque écriture d'un membre (`runtime().forget`) ;
2. la pause de l'offre (`deps.pauses`), relue après le cache : un lien en pause
   répond comme un lien inconnu ;
3. retiré par l'administration : `410` « Lien retiré » ;
4. coupé par son auteur : `404` ;
5. expiré, par sa date ou par ses visites (celles pas encore écrites
   comprises) : `410` « Ce lien a expiré » ;
6. la limite mensuelle des visites de l'offre du propriétaire : `503`
   « momentanément indisponible », sans un mot sur les offres ;
7. un mot de passe : la page qui le demande (`401`), puis `303` vers la
   destination une fois saisi, sans cookie (chaque passage redemande) ;
8. la destination de l'appareil (iPhone ou iPad, Android, les autres), à
   laquelle s'ajoutent les paramètres de campagne non vides, qui remplacent
   ceux du même nom ;
9. le comptage, puis `302` sans cache. Jamais `301` : la destination change,
   et chaque passage doit revenir ici pour être compté.

Sous `/l/:code`, un lien ne répond que sous une adresse de DevEye ou sous un
domaine vérifié de son espace : n'importe qui ne peut pas le faire paraître
sous le domaine d'un autre. Sous un domaine client, l'alias se cherche dans
CE domaine, et un alias d'un autre espace y répond « introuvable ».

Les pages (`server/render.ts`) n'ont aucun script, aucune ressource distante,
leur propre CSP (`frame-ancestors 'none'`, `form-action 'self'`) et
`noindex`. Leurs couleurs sont leurs propres jetons, clair et sombre.

## Les compteurs

`server/counters.ts`. Rien ne s'écrit sur le chemin chaud : les passages
s'accumulent en mémoire et un ticker les vide chaque seconde.

- L'**empreinte du jour** d'une personne : `visitorRef` du SDK, sur le lien,
  l'IP et le user-agent, sous un sel dérivé de la clé du serveur
  (`keys.derive('shortlinks', 'visitor-salt', 32)`) et du jour. L'adresse IP
  n'est jamais gardée : elle entre dans l'empreinte et dans le pays, puis
  s'oublie. Deux liens donnent deux empreintes sans rapport.
- `ft_shortlinks_seen` fait foi : au vidage, un `INSERT IGNORE` par personne
  candidate, et une ligne insérée est une nouvelle visite. La mémoire du jour,
  bornée, ne sert qu'à ne pas reconsulter la base pour quelqu'un déjà vu.
  Après un redémarrage, la base suffit. Les jours passés s'effacent chaque
  heure.
- Une nouvelle visite range sa **provenance** dans `ft_shortlinks_dims`, par
  jour : pays (base DB-IP du socle, capacité `geoip`), type d'appareil,
  navigateur, système, langue principale du navigateur, site d'origine (l'hôte
  du `Referer`, jamais l'URL entière). Les cinq premiers sont des codes en clair
  d'un vocabulaire fermé, qu'un condensé révélerait de toute façon. Le site
  d'origine passe par une étiquette chiffrée de l'espace
  (`ft_shortlinks_labels`, condensé à clé `label-ref`), ce qui permet de grouper
  sans le stocker en clair.
- Les sommes vont dans `ft_shortlinks_daily` (ouvertures, visites, robots par
  lien et par jour), les totaux du lien, et l'usage du mois de l'espace
  (`ft_shortlinks_usage`), sur l'espace et non sur le lien pour qu'un lien
  supprimé puis recréé ne rende pas le mois.
- La liste et les chiffres se raniment par le sujet `shortlinksStats`, battu au
  plus une fois par minute et par espace.

Une file pleine (au-delà de 50 000 personnes en attente d'un vidage) perd le
surplus et le dit au journal.

## Les statistiques

`shortlinks.stats`, pour un lien ou pour tous ceux que l'espace voit : la série
par jour sur 7, 30 ou 90 jours, par semaine sur 52 semaines, les totaux, ceux
de la période de même durée juste avant, et les dix premiers de chaque
provenance. Les sites d'origine se déchiffrent chacun avec la clé de son espace
et se fusionnent par nom.

Les lignes quotidiennes vivent autant que le lien ; les provenances sont
gardées 400 jours, de quoi comparer douze mois au précédent.

Le classement par pays porte la mention exigée par la licence de la base
(« IP Geolocation by DB-IP », CC BY 4.0), rendue par le serveur avec les
chiffres.

## Le contrôle des destinations

`server/checker.ts`. Chaque lien actif qui le demande (réglage par lien,
activé par défaut) voit sa destination vérifiée chaque jour : `HEAD`, puis
`GET` pour un site qui refuse `HEAD`, par le garde des appels sortants de l'app
(`safeFetch`). Toutes les destinations du lien comptent, une seule en panne
suffit.

- Un premier échec se revérifie dans l'heure ; le second fait passer le lien à
  « destination injoignable ». L'erreur se garde sous forme de catégorie
  (« code 404 », « délai dépassé »), jamais d'un message réseau qui nommerait
  la destination.
- L'avis part sur le changement d'état seulement, à l'aller et au retour, **un
  par espace et par destination** : vingt liens vers le même site tombé font un
  avis, qui en nomme trois et compte les autres, vers les canaux de tous
  (`notify.send(alert, { itemIds })`).
- Un lien que l'offre tient en pause n'est pas vérifié.
- « Vérifier maintenant » (`shortlinks.checkNow`) tranche tout de suite, sans
  seconde chance.

## Le signalement et la modération

Un visiteur signale un lien depuis son aperçu (`<adresse>+`) ou
`/l/<code>/signaler` : motif, message, nom, adresse e-mail, déclaration de bonne
foi, et un champ piège pour les robots. Le signalement (`ft_shortlinks_reports`)
est scellé par la clé du serveur, lisible sans aucun espace, et survit au lien
comme à son auteur : c'est la trace de la décision. Les modérateurs et les
administrateurs le reçoivent par mail (`accountMail.sendToModerators`, au plus
trente par heure, au-delà l'onglet suffit), sans l'adresse ni l'IP du
signalant ; son bouton ouvre la modération sur Liens courts
(`/?moderation=shortlinks`). Le signalement enregistré, la route appelle
`live.pendingChanged()` : les badges de la modération s'allument en direct.

L'onglet « Signalements » de l'administration des fonctionnalités
(`adminTabs`, `moderation: true`, commandes `shortlinks.reports`,
`reportDecide`, `restore`, `access: { scope: 'account', moderation: true }`)
liste ce qui est **à traiter**, et dessous, replié, ce qui est **traité**. Il
permet de **retirer** le lien, pour tout le monde, sans rien supprimer, en
prévenant son auteur par mail et l'espace par ses canaux, avec le motif ; de
classer sans suite ; ou de remettre un lien en service. Le compte, lui, n'est
jamais coupé par cet onglet : on sanctionne un lien, pas un usage (la
restriction d'un compte se fait dans l'administration des abonnements).

Un modérateur juge le contenu (adresse, destination, motif, message, nom du
signalant) ; l'adresse e-mail et l'IP du signalant ne sortent du serveur que
vers un administrateur, les autres les reçoivent à `null`. Chaque décision et
chaque remise en service appelle `ctx.live.pendingChanged()` : le compteur
`adminPending` (`reports`, les signalements ouverts) se relit, et la liste se
rafraîchit chez les autres modérateurs (`alsoInvalidatedBy` sur le sujet
`pending`). La vue d'ensemble de l'administrateur montre en plus les visites et
les ouvertures de toute l'instance (`adminFacts`), les liens étant déjà comptés
par leur quota.

Un signalement clos se garde un an.

## Les statuts de compte

- **Restreinte**, ou une offre qui baisse : la limite de liens tombe, le
  réconciliateur met en pause les plus récents, qui répondent « introuvable »
  sans être supprimés, et ne sont plus vérifiés. Ils repartent seuls quand la
  limite remonte.
- **Limite des visites atteinte** : tous les liens du compte répondent
  « momentanément indisponible » jusqu'au mois suivant ; un avis part à 80 %,
  un autre à la limite, une fois chacun par mois et par espace.
- **Priorité aux abonnés** : les comptes sans priorité voient leurs limites à
  0 le temps de la priorité, leurs liens aussi.
- **Maintenance** : `503` comme toute route publique.
- **Suppression du compte** : les liens partent avec leur espace
  (`ON DELETE CASCADE`), leurs chiffres avec eux.

## Partage

Un lien se projette dans un autre espace comme un service d'Uptime : la liste,
la fiche et les chiffres s'y lisent, chiffrés sous la clé du domicile. Son
adresse (domaine, alias) ne se règle que depuis son espace d'origine, et il ne
s'y supprime pas : on retire la projection.

## Commandes

| Commande                    | Accès      | Rôle                                     |
| --------------------------- | ---------- | ---------------------------------------- |
| `shortlinks.count`          | lecture    | la carte d'accueil                       |
| `shortlinks.list`           | lecture    | les liens visibles et l'usage de l'offre |
| `shortlinks.get`            | lecture    | un lien                                  |
| `shortlinks.add`            | écriture   | créer : destination, titre, adresse      |
| `shortlinks.update`         | écriture   | l'onglet Général                         |
| `shortlinks.updateAccess`   | écriture   | l'onglet Accès (mot de passe, fin)       |
| `shortlinks.updateCampaign` | écriture   | l'onglet Campagne                        |
| `shortlinks.setEnabled`     | écriture   | couper ou rétablir                       |
| `shortlinks.remove`         | écriture   | supprimer avec ses chiffres              |
| `shortlinks.stats`          | lecture    | les chiffres d'un lien ou de tous        |
| `shortlinks.qr`             | lecture    | le QR code d'une adresse, en SVG         |
| `shortlinks.checkNow`       | écriture   | vérifier la destination tout de suite    |
| `shortlinks.reports`        | modération | les signalements                         |
| `shortlinks.reportDecide`   | modération | retirer le lien, ou classer              |
| `shortlinks.restore`        | modération | remettre un lien retiré en service       |

## Carte du code

### Le module : `features/shortlinks/`

- `src/manifest.ts` : capacités (`notify`, `routes.public`, `accounts.mail`,
  `geoip`), quotas, domaines web, onglet de modération, onglets.
- `src/contracts/domain.ts`, `commands.ts` : les formes et les commandes.

### Serveur : `src/server/`

- `index.ts` : l'entrée, le service (compteurs, contrôle, entretien horaire),
  `ownHosts`, `publicRoutes`, `hostRequest`, `adminPending`, `adminFacts`.
- `_shared.ts` : adresses, destination d'un appareil, mot de passe, expiration,
  le pont vers le service (`runtime()`).
- `repo.ts` : toutes les requêtes ; `_testing.ts` : son double en mémoire.
- `handlers.ts` : les commandes des membres ; `moderation.ts` : celles de la
  modération.
- `redirect.ts` : les routes publiques ; `render.ts` : leurs pages.
- `counters.ts` : visites, ouvertures, provenances, usage, avis de limite.
- `stats.ts` : les séries et les classements.
- `checker.ts` : le contrôle des destinations.
- `reports.ts`, `mails.ts` : le signalement scellé et les deux mails.
- `domains.ts` : la preuve d'un domaine.
- `accountExport.ts`, `e2e.ts`, `env.ts`.
- `migrations/001_shortlinks.sql`, `uninstall.sql`.

### Client : `src/client/`

- `Shortlinks.tsx` : la vue, l'usage, les chiffres de tous les liens, la liste.
- `LinkDetail.tsx` : la fiche d'un lien ; `QrDialog.tsx`, `CopyLink.tsx`.
- `LinkDialog.tsx` : la création ; `AddressFields.tsx` : domaine et alias.
- `LinkGeneralPanel.tsx`, `LinkAccessPanel.tsx`, `LinkCampaignPanel.tsx` : les
  onglets de réglages d'un lien.
- `StatsBlock.tsx`, `RangeBar.tsx`, `Stats/` : le graphique et les classements.
- `UsageNotice.tsx`, `LinkStatus.tsx`, `ShortlinksWidget.tsx`, `Reports.tsx`.

### Ce qui vient du socle

- Les noms servis en entier (`FeatureService.ownHosts`, `hostRequest`) et leur
  réservation : `src/features/_sdk/register.ts`.
- Le pays d'une adresse : `src/Services/geoip.ts` (base DB-IP, capacité
  `geoip`).
- Les outils de visiteurs (`parseUserAgent`, `looksLikeBot`, `visitorRef`,
  `normalizeReferrer`) : `@deveye/types/sdk/server`.

## Configuration

Lue par le module lui-même (`src/server/env.ts`, `defineModuleEnv`), pas par
`Utils/Env`, et nommée au démarrage si elle reste à son défaut :

| Variable                 | Défaut | Rôle                                                                         |
| ------------------------ | ------ | ---------------------------------------------------------------------------- |
| `SHORTLINKS_ORIGIN`      | vide   | le domaine court de l'instance (`https://dvy.fr`), servi à la racine         |
| `SHORTLINKS_LISTEN_PORT` | `0`    | le port de l'écouteur réservé aux liens (`3002`), qui exige le domaine court |

Du socle : `PUBLIC_ORIGIN` et `AUDIENCE_ORIGIN` (l'adresse sous laquelle `/l/`
répond), `SITE_URL` (le pied des pages et la racine du domaine court),
`OUTBOUND_ALLOW_PRIVATE` (accepter une destination privée, pour une
installation personnelle). La base des pays se télécharge seule dès que le
module est installé (page Services externes, « Pays des visiteurs »).

## Les quotas de l'offre

Deux clés déclarées par le manifest, bornées par le module de facturation des
comptes (`DevEye-Billing/src/server/plans.ts`) :

| Clé                 | Ce qu'elle compte          | Gratuite | Pro     |
| ------------------- | -------------------------- | -------- | ------- |
| `shortlinks.links`  | liens courts (stock)       | 1        | 100     |
| `shortlinks.visits` | visites des liens par mois | 100      | 100 000 |

Un domaine à soi passe par la limite du socle `domains.hosts`. Une installation
sans module de facturation n'a aucune limite.

## Tests

```bash
cd DevEye
npm run test:features
```

Le scénario `e2e.ts` (page Tests et débogage) crée un lien de ce serveur même,
le suit et lit sa redirection et ses paramètres de campagne, ouvre son aperçu,
le protège par un mot de passe (mauvais puis bon), attend la visite dans ses
chiffres, et le suit sous le domaine court quand il est posé.
