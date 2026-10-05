# Facturation

Les devis et les factures d'un espace, pour des prestations de services : un
carnet de clients, un devis qu'on fait accepter en ligne, sa conversion en
facture, le suivi de ce qui reste dû.

Ce document dit **pourquoi** la feature est faite ainsi. Le « quoi » est dans les
contrats (`src/contracts/`) et le « comment » dans le code, qui est commenté.
C'est un module in-repo sur le SDK des features
([Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md)) : ses contrats, son dépôt, ses
handlers et son client vivent dans `features/invoicing/`, et `@deveye/types`
n'en garde que l'identité et les deux contrats de couplage
(`INVOICING_LEDGER_PROVIDER`, `INVOICING_CLIENT_PROVIDER`).

---

## Les cinq décisions qui portent tout le reste

### 1. Les montants sont des entiers de centimes, les quantités des millièmes

`BIGINT` en base, `number` entier sur le fil, jamais un flottant, jamais un
`DECIMAL`. La division par cent est la **dernière** étape, faite à l'affichage
seul. Un montant est toujours **positif** : le sens vient du type de pièce, pas
du signe, sans quoi « un avoir de -300 € » existerait à côté d'un avoir de
300 €, et chaque écran devrait se demander ce qu'il regarde.

Les quantités sont en millièmes d'unité (`1000` = une unité, `500` = une
demi-journée, `1333` = 1 h 20) : trois décimales suffisent à tout ce qu'une
prestation se compte, et aucune fraction décimale n'est exacte en binaire.

**Un seul endroit arrondit**, `src/contracts/money.ts`, et le SQL ne calcule
jamais un montant : il ne somme que des colonnes déjà arrondies là. C'est ce qui
permet au client de totaliser en direct et au serveur de figer le même total à
l'émission, sans deux implémentations à tenir d'accord.

La TVA se calcule **par taux sur la base agrégée**, jamais ligne par ligne :
c'est la pratique française, et c'est ce qui évite le centime d'écart entre le
récapitulatif imprimé et le total. La somme des tranches est donc égale au total
de TVA par construction, et un test le vérifie.

Le **régime de TVA d'un brouillon est celui des réglages**, pas celui qui régnait
le jour de sa création : il suit le vivant comme il suit le nom vivant de son
client, puisque rien n'y est encore engagé. Passer à la TVA rattrape donc les
brouillons en attente, et repasser en franchise efface les taux qu'ils portaient,
à l'écran comme dans leurs totaux. L'émission fige les deux ensemble, régime et
taux de chaque ligne : une pièce émise ne peut pas dire « franchise » et porter
de la TVA. Une écriture de lignes en franchise ramène les taux à zéro plutôt que
de refuser : un refus aurait bloqué l'édition d'un brouillon né avant le
changement, sans qu'aucun geste de l'écran ne puisse le débloquer.

### 2. Les dates sont des jours, pas des instants

Colonnes `DATE`, chaînes `AAAA-MM-JJ`, comparables et triables telles quelles.
Une pièce appartient à un jour civil : un horodatage la ferait changer de mois
comptable selon le fuseau de qui la regarde. Le calcul passe par `Date.UTC` de
bout en bout (`src/contracts/calendar.ts`), sans quoi additionner des jours
sauterait une heure au changement d'heure d'été.

« Aujourd'hui » n'est jamais `CURDATE()` : il est calculé dans le **fuseau de
l'espace** et passé en paramètre. Sans cela, une pièce émise depuis La Réunion
porterait la date de la veille tant que le serveur est en Europe.

### 3. L'élément de la feature est le client, pas le document

Un espace accumule des centaines de documents : en faire des éléments rendrait
l'écran des rôles illisible, et un élément est fait pour porter des réglages, ce
qu'un document n'a pas. Le client, lui, est la seule entité durable et nommable,
celle qu'un rôle a une raison de fermer, et un document hérite de la restriction
du sien.

Conséquence heureuse : le document n'étant pas un élément, la règle « pas de
bouton Modifier, tout passe par l'onglet Général » ne le lie pas, et son en-tête
s'édite directement dans la page tant qu'il est brouillon. C'est la seule
interface tenable pour une pièce qu'on est en train de rédiger.

### 4. Étage ouvert, texte libre chiffré, nombres en clair

Tout passe par `ctx.cipher()`, l'étage ouvert : les documents appartiennent à
l'**espace**, et tout membre d'un espace partagé doit pouvoir les lire sans
dépendre de la session de son propriétaire. La feature ne demande donc jamais de
mot de passe.

Ce qui est chiffré : identités, adresses, coordonnées bancaires, intitulés de
ligne, notes. Ce qui reste en clair : montants, taux, dates, statuts, numéros.
La raison n'est pas le confort : un reste dû et un encaissement du mois sont des
`SUM(...) GROUP BY`, et le chiffrement de DevEye est non déterministe. Rien de ce
sur quoi on agrège ne peut le traverser.

### 5. C'est le client qui répond, pas l'émetteur à sa place

Le lien public **naît avec l'émission**, et non d'un clic séparé : c'est par lui
que le document est remis, et le faire naître à la demande revenait à cacher le
canal principal derrière un geste. Il reste révocable (`invoicing.share`), et
peut renaître après révocation.

La page qu'il ouvre porte les **deux** réponses, l'accord et le refus. N'offrir
que l'accord obligeait un client qui refuse à écrire un courriel, et l'émetteur
ne savait jamais où il en était. Noter la réponse soi-même reste possible, mais
c'est la voie de secours : elle est présentée comme telle, sous le lien.

Le **cadre « bon pour accord »** et la réponse en ligne ne paraissent jamais
ensemble. Le cadre ne sort que sur un devis qui attend encore (`awaitingAnswer`) :
derrière une réponse déjà donnée, il invitait à signer une seconde fois, à côté
de la ligne qui disait l'accord. Et sur la page publique, où les deux pourraient
coexister, chacun a son médium : le formulaire à l'écran, où l'on clique, le cadre
à l'impression, où l'on signe.

Une réponse en ligne bat le sujet live de la feature (`deps.live.changed`) : la
fiche ouverte chez l'émetteur se relit d'elle-même. **Jamais un brouillon**,
lui : sa vérité est à l'écran, et le relire écraserait ce qui est en train
d'être tapé. C'est pourquoi les brouillons ont leur sujet secondaire,
`invoicingDrafts` (`invoicing.docList`, `invoicing.doc`) : un brouillon se
retouche vingt fois, et chaque enregistrement ne doit pas faire recalculer le
tableau de bord et la carte d'accueil de tout l'espace.

---

## Comment ça marche

### Les pièces

Trois types (`documentKindSchema`) : devis, facture, avoir. Une pièce naît
**brouillon** (`invoicing.docSave`, `invoicing.linesSet`), se relit avec ses
totaux recalculés et le nom vivant de son client (`src/server/views.ts`), puis
s'**émet** (`invoicing.docIssue`, droit `issue`) : elle prend un numéro et fige
tout, l'émetteur et le client en instantanés, le régime et les taux. Un
document émis ne se reprend pas : il se corrige par un avoir. La date
d'émission peut remonter d'un mois au plus (`BACKDATE_DAYS`), et l'émission
refuse tant que la dénomination et le SIRET de l'émetteur manquent
(`src/contracts/issuer.ts`, la même règle que l'écran lit pour prévenir avant).

La **numérotation** (`src/server/numbering.ts`) est chronologique et continue,
sans transaction : le numéro n'existe que là où il est écrit. Le rang se lit du
plus grand déjà posé et s'écrit sur le document sous garde `number IS NULL` ;
l'index unique (espace, type, année, rang) refuse un doublon, et la commande
réessaie. Un compteur à part consommerait un rang à chaque échec entre les deux
écritures, donc un trou.

Les **dérivations** (`invoicing.docDerive`) sont trois : un devis vers sa
facture, un devis vers une facture d'acompte (`is_deposit`, dont le montant est
déduit de la facture de solde, `ft_invoicing_deductions`), une facture vers son
avoir. Aucune ne fige quoi que ce soit : elles rendent un brouillon, qui se
corrige avant d'être émis. L'avoir partiel n'a donc pas de commande à lui : on
dérive l'avoir total, puis on retire ou on réduit ses lignes.

Un devis peut **annoncer son acompte** (`deposit_bp`) : le client l'accepte
alors avec le devis, au lieu de le découvrir à la facture. Sans part à lui, un
brouillon suit celle des réglages (Mentions, zéro par défaut), et l'émission la
fige comme la validité ; zéro dit « pas d'acompte ». Le papier l'imprime sous le
total, avec son montant, et la boîte « Facture d'acompte » s'ouvre sur cette
part, qu'on peut encore changer (deux acomptes, par exemple). Le montant annoncé
et celui de la facture d'acompte sortent du même calcul (`depositTotals`) : ils
sont égaux au centime.

Le **statut affiché** (`src/contracts/status.ts`) n'est pas celui qui est
stocké : « en retard », « payée », « expiré », « envoyé » sont des fonctions des
dates, des sommes, du jour courant et de l'envoi (`sentAt`). Les stocker
demanderait une tâche de fond pour faire passer minuit. La fonction est partagée
par le client et le serveur, et le dépôt écrit le même prédicat en SQL pour
filtrer « en retard ».

Une pièce émise ne se dé-émet pas : pour la reprendre, on **duplique**
(`invoicing.docDuplicate`). Le brouillon neuf garde le client, le texte, les
lignes et ce qui le rattache (le devis d'origine, la facture qu'un avoir
corrige, les acomptes déduits), et perd tout ce que l'émission avait posé :
numéro, dates, lien, réponse du client. Un **brouillon** se supprime
(`invoicing.docRemove`), puisqu'il n'a pas de numéro ; une pièce émise
s'**archive** (`invoicing.docArchive`), la loi demandant de la conserver.
L'archive est un rangement, pas un effacement : elle sort la pièce de l'accueil,
de la liste et des relances, et la laisse dans tous les chiffres (tableau de
bord, reste dû, fiche client, ce que Finances lit). Les archives ont leur onglet
dans les réglages de la feature, d'où chaque pièce s'ouvre et se ressort.

Ces gestes vivent dans les réglages du document, ouverts par le bouton commun
sur la portée `record` de la coquille : le document n'est pas un élément, mais
ses réglages s'ouvrent par la même porte que tous les autres.

Les **règlements** (`invoicing.paymentSave`, `invoicing.paymentRemove`) se
notent sur une facture émise ; la part de TVA d'un règlement vient de
`paymentVatCents` (`src/contracts/money.ts`), la même que celle du tableau de
bord. L'onglet Général des réglages signale que DevEye n'est pas une plateforme
agréée de facturation électronique (voir « Limites connues »).

### Le papier

Un document imprimable est **une chaîne HTML autonome** (`src/server/paper.ts`,
nourrie par `paperInput.ts`), construite côté serveur et servie trois fois :
l'aperçu et l'impression dans l'application (`invoicing.paper`, puis le
dialogue d'impression du navigateur, `src/client/printDocument.ts`), la page
publique que le client ouvre, et le corps du courriel. Une seule mise en page,
donc aucune divergence entre ce que l'utilisateur voit, ce que son client
reçoit et ce qui s'imprime. La mise en forme des montants et des dates est
partagée par l'écran et le papier (`src/contracts/display.ts`).

### La page publique et la réponse

Le service du module (`src/server/service.ts`) sert deux routes publiques,
sans session : la page d'un document, `GET /f/<jeton>` (120 visites par minute
et par adresse), et la réponse à un devis, `POST /api/invoicing/answer` (10 par
minute). Le jeton porté par l'URL est la seule autorisation, et il ne dit rien
d'autre que « ce document-là ». La page ne contient pas un octet de
JavaScript : le formulaire de réponse est un `<form method="post">` ordinaire
(`src/server/publicPage.ts`).

### L'envoi au client

`invoicing.send` expédie le document **en HTML dans le corps du message**
(`src/server/documentMail.ts`), avec le lien vers sa page, par un compte Mail
de l'espace choisi dans la liste que rend `invoicing.mailAccounts` (la façade
`ctx.deveye.mail.listAccounts`, capacité `mail.accounts`) et le transport
`MAIL_TRANSPORT_PROVIDER`. Le texte brut reste complet : un destinataire dont
le client n'affiche pas le HTML ne perd rien. Les gabarits de ces mails sont
offerts à la page Tests et débogage (`mailSamples`).

### Les relances

Le même service relance les factures en retard par les canaux de notification
de l'espace (capacité `notify`) : un tour toutes les six heures, cinquante
factures par tour, et la même facture n'est redite qu'après sept jours
(`REMIND_AGAIN_DAYS`). Le balayage prend le jour du serveur : une relance
décalée d'un jour pour qui facture depuis l'autre bout du monde est sans
conséquence.

### Les clients

Le client est l'élément (`hasItems`, `itemNoun: 'client'`) : son onglet Général
porte son identité et son retrait (`invoicing.clientSave`,
`invoicing.clientRemove`), et sa fiche résume ce qu'il a été facturé, ce qui
reste dû et ce qui est en retard. Les coordonnées d'un client se ferment en
fermant le client, par les restrictions d'élément : il n'y a pas de droit « voir
les coordonnées », une facture **étant** l'identité d'un tiers plus un montant.

### Les réglages

Une ligne par espace (`ft_invoicing_settings`), lue avec ses défauts
(`src/contracts/defaults.ts`) tant qu'elle n'existe pas : une lecture n'écrit
jamais. Quatre panneaux de réglages à l'échelle de la feature écrivent le même
objet (`src/client/settingsDraft.ts`) : Général (l'émetteur, `IssuerPanel`,
sous le droit `issuer` : dénomination, adresse, SIRET, numéro de TVA,
coordonnées bancaires, logo), TVA (`TaxesPanel`), Numérotation
(`NumberingPanel`), Mentions (`WordingPanel`), plus l'onglet Domaines du socle.
À l'échelle d'un client, Général est `ClientPanel`.

## Les liens sous le domaine de l'émetteur

L'onglet Domaines est celui du socle (`manifest.domains`, déclaré `web`). Un
seul domaine sert tout l'espace, choisi dans l'onglet Général
(`ft_invoicing_settings.domain_id`) : le client est l'élément, mais c'est
l'émetteur qui a un nom, pas chacun de ses clients. Tant que le domaine n'est
pas vérifié, les liens repartent sur l'adresse de DevEye, et un lien déjà remis
sur l'une reste bon sur l'autre, puisque le jeton seul désigne le document. Le
module vérifie qu'un domaine est bien le sien par le jeton que sa route
publique rend sous `/.well-known/deveye-invoicing` (`src/server/domains.ts`).

La page d'un document ne se montre que sous l'adresse de DevEye ou sous un
domaine de **son** espace. Sans cette règle, n'importe quel émetteur ferait
paraître sa facture, et son IBAN, sous le domaine d'un autre, en changeant
seulement le nom d'hôte du lien : c'est le scénario d'une fraude au virement.

## Ce que Finances en lit

Le module offre `INVOICING_LEDGER_PROVIDER` (`src/server/ledger.ts`) : les
règlements, les factures qui attendent encore (500 au plus : au-delà, une
créance de plus ne change rien à ce qu'un tableau de bord en montre), la devise
et le régime de TVA. Finances recopie les règlements dans son livre et montre ce
qui reste à encaisser ; rien n'y écrit, et Facturation ne sait rien de
Finances. La version qu'il expose (le nombre de règlements et le plus grand
identifiant, que MySQL ne réattribue jamais) permet à Finances de ne rien
relire tant que rien n'a bougé. La part de TVA d'un règlement vient de
`paymentVatCents`, la même que celle du tableau de bord : les deux features
disent la même chose au centime.

Dans l'autre sens, le contrat client `INVOICING_CLIENT_PROVIDER`
(`src/client/provider.ts`) laisse Finances enregistrer le règlement d'une ligne
de relevé reconnue : c'est `invoicing.paymentSave` qui s'exécute, sous la
session de la personne, avec ses droits et son audit.

## Carte du code

- `src/manifest.ts` : le descripteur du registre (`featureDescriptor('invoicing')`,
  `shareTier: 'never'`, l'élément est le client), la catégorie `work`, six clés
  de ressources, le sujet secondaire `invoicingDrafts`, le sujet `domain` qui
  ravive les adresses des liens, le bloc `domains` (`web`), les deux quotas,
  les capacités `notify`, `routes.public` et `mail.accounts`, les deux droits
  propres (`issue`, `issuer`), les onglets de réglages (dont ceux d'un document,
  `settings.record`) et les vingt-cinq commandes sous le préfixe `invoicing.`.
- `src/contracts/` : `domain.ts` (schémas et lignes SQL), `commands.ts`,
  `money.ts` (le seul endroit qui arrondit), `calendar.ts` (les jours civils),
  `status.ts` (le statut affiché), `display.ts` (la mise en forme partagée),
  `issuer.ts` (ce que la loi exige de l'émetteur), `defaults.ts` (les réglages
  par défaut), et leurs tests `money.test.ts`, `calendar.test.ts`,
  `status.test.ts`.
- `src/server/` : `index.ts` (l'entrée : dépôt, handlers, migrations, service,
  crochets de domaines, quotas, gabarits de mail, export du compte, et une
  entrée `items` qui ne sert qu'à nommer un client dans l'écran des canaux),
  `repo.ts`, `_shared.ts` (le contexte, `CipherIo`, les gardes), `views.ts`,
  `numbering.ts`, `paper.ts`, `paperInput.ts`, `publicPage.ts`,
  `documentMail.ts`, `ledger.ts`, `planUsage.ts` (ce qu'un compte a émis ce
  mois-ci), `domains.ts`, `service.ts`, `accountExport.ts`, `handlers/`
  (`settings`, `clients`, `docs`, `issue`, `paper`, `payments`, `derive`,
  `share`, `send`, `copy` pour l'archive, la duplication et le passage d'un
  espace à l'autre, et `index.ts` qui porte `invoicing.count`),
  `migrations/001_invoicing.sql` (les six tables `ft_invoicing_*`),
  `002_invoicing_deposit.sql` (le drapeau d'acompte), `003_invoicing_domain.sql`
  (le domaine des liens), `004_invoicing_archive.sql` (l'archive),
  `005_invoicing_quote_deposit.sql` (l'acompte annoncé par un devis),
  `uninstall.sql`, `_memoryRepo.ts` (le dépôt en
  mémoire des tests) et les tests `settings`, `clients`, `docs`, `issue`,
  `payments`, `derive`, `copy`, `ledger`, `paper`, `remind`, `routes`,
  `domains`, `accountExport` (`*.test.ts`).
- `src/client/` : `index.tsx` (l'entrée : widget, vue, quatre panneaux,
  `cacheDurationMinutes: 0`, le contrat client), `Invoicing.tsx`, `Home.tsx`
  (le tableau de bord, `Charts/MonthBars.tsx`), `DocumentsPage.tsx`,
  `DocumentSheet.tsx` (la fiche d'une pièce : `LineEditor`, `LineTable`,
  `Totals`, `PaymentsBlock`, `DocumentPreview`), `DocumentDialog.tsx`,
  `DocumentRow.tsx`, `ClientsPage.tsx`, `ClientSheet.tsx`, `ClientDialog.tsx`,
  `ClientPicker.tsx`, `ClientRow.tsx`, les panneaux `GeneralPanel.tsx`
  (`IssuerPanel`, `ClientPanel` ou `DocumentGeneralPanel` selon la portée),
  `TaxesPanel.tsx`, `NumberingPanel.tsx`, `WordingPanel.tsx`,
  `ArchivesPanel.tsx`, `DocumentElsewherePanel.tsx`, `navigation.ts` (un
  panneau de réglages qui ouvre un document), `settingsDraft.ts`,
  `printDocument.ts`, `provider.ts`, `QuotaNote.tsx`, `ErrorNote.tsx` et
  `errors.ts` (un refus, et l'onglet de réglages qui le lève), `format.ts`,
  `api.ts`, `InvoicingWidget.tsx`, `style.module.css`.
- `deveye-feature.json` : aucune table en allowlist, toutes portent le préfixe
  du module.

Aucune variable d'environnement n'est propre au module.

## Quotas, notifications, partage

- **L'offre** : deux limites par mois, `invoicing.quotesPerMonth` et
  `invoicing.invoicesPerMonth` (Gratuite 5, Pro 100, valeurs de
  `DevEye-Billing/src/server/plans.ts`), comptées à l'émission sur tous les
  espaces du propriétaire ; proposer et facturer ne sont pas le même geste, et
  une seule enveloppe aurait fait payer au devis la place de sa facture. Les
  brouillons ne comptent pas. Le panneau de réglages montre ce qui a été émis
  dans le mois (`QuotaNote`). Une installation sans module de facturation n'a
  aucune limite.
- **Notifications** (`notifies: true`) : quand une facture dépasse son échéance
  sans être soldée, et quand un client accepte ou refuse un devis depuis le
  lien qu'il a reçu ; par les canaux de l'espace.
- **Partage** : `shareTier: 'never'`. Les documents d'un espace ne se projettent
  pas. Ils passent dans un autre espace de l'appelant par l'onglet « Autre
  espace » de leurs réglages, et y arrivent **toujours en brouillon** : un
  numéro appartient à la suite de l'espace qui l'a émis, et une pièce émise
  posée ailleurs y ferait un numéro étranger. Copier vaut donc pour tout
  document, déplacer pour un brouillon seulement. Le navigateur porte l'un à
  l'autre (`invoicing.docExport` ici, `invoicing.docImport` là-bas, envoyée avec
  `{ workspaceId }`), chaque moitié sous les droits de l'appelant dans son
  espace. Le client est repris là-bas s'il y existe sous le même nom (et le
  même SIRET quand les deux en ont un), créé sinon. La confirmation nomme ce
  qui ne suit pas : numéro, lien et domaine, réponse, règlements, relances,
  liens avec d'autres pièces, échéances, et l'écart de devise ou de régime.

## Tests

```bash
npm run test:features
```

## Limites connues, et assumées

- **Pas de pièce jointe PDF.** Le document part en HTML dans le corps du mail,
  avec un lien vers sa page, comme le font Stripe et Qonto ; le PDF s'obtient
  depuis l'app par le dialogue d'impression du navigateur. Une vraie pièce
  jointe demanderait un moteur de rendu navigateur côté serveur.
- **Pas de Factur-X, et DevEye n'est pas une plateforme agréée.** La réforme
  française fait passer les factures entre entreprises par une plateforme
  agréée : la réception est obligatoire pour toutes depuis le 1er septembre 2026,
  l'émission le devient pour les TPE et PME le 1er septembre 2027. L'onglet
  Général des réglages le dit à l'utilisateur. Le modèle de données est taillé
  pour l'export structuré (SIREN et numéro de TVA des deux parties en champs
  propres, ventilation par taux reconstituable, identité de pièce immuable),
  mais rien ne le produit.
- **La réponse en ligne d'un devis** (accord ou refus) vaut un « bon pour accord »
  horodaté, pas une signature électronique qualifiée.
- **Le carnet de clients se trie en mémoire** : le nom est chiffré, et le
  chiffrement non déterministe interdit de trier en SQL. Le listage garde donc
  une borne dure de 500 clients (`listClients`, `ORDER BY id DESC LIMIT 500`).
  Au-delà, il faudrait une empreinte dérivée comme colonne de tri.
