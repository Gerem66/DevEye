# Finances

La trésorerie d'une activité : ses comptes, ses opérations, ses échéances, et la
TVA quand elle est suivie. Elle s'adresse à qui facture des clients (un
freelance, une petite agence), pas à la gestion d'un budget personnel.

Ce document dit **pourquoi** la feature est faite ainsi. Le « quoi » est dans les
schémas (`src/contracts/domain.ts`) et le « comment » dans le code, qui est
commenté. C'est un module in-repo sur le SDK des features
([Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md)) : ses contrats, son dépôt, ses
handlers et son client vivent tous dans `features/finance/`, et `@deveye/types`
n'en garde que l'identité.

---

## Les trois décisions qui portent tout le reste

### 1. Les montants sont des entiers de centimes

`BIGINT` en base, `number` entier sur le fil, jamais un flottant nulle part. La
division par cent est la **dernière** étape, faite à l'affichage seul
(`format.ts`). `0.1 + 0.2 !== 0.3` est une curiosité amusante partout sauf sur un
solde, où l'écart s'accumule silencieusement jusqu'à ce que la somme des lignes
ne retombe plus sur le total affiché.

Corollaire : le montant est toujours **positif**, et le sens vient du `kind`
(`expense`, `income`, `transfer`). Un montant signé laisserait exister « une
dépense de -30 € », qui est une recette écrite de travers, et chaque écran
devrait ensuite se demander ce qu'il regarde.

### 2. Les dates sont des jours, pas des instants

Colonnes `DATE`, chaînes `AAAA-MM-JJ`, contrairement au reste du schéma qui est
en epoch. Une opération appartient à un jour civil : un horodatage se décalerait
d'un fuseau à l'autre et ferait basculer une dépense du 31 janvier au 1er
février selon qui la regarde, donc changerait de mois comptable.

Deux conséquences dans le code :

- le dépôt projette **toujours** ces colonnes par `DATE_FORMAT(..., '%Y-%m-%d')`,
  parce que mysql2 rendrait sinon un objet `Date` recalé sur le fuseau de Node.
  C'est pourquoi il n'y a aucun `SELECT *` dans `src/server/repo.ts` ;
- « aujourd'hui » est **passé en paramètre** aux requêtes, jamais lu par
  `CURDATE()` : le fuseau de MySQL et celui du processus Node n'ont aucune raison
  de coïncider, et un solde ne doit pas osciller autour de minuit. Ce paramètre
  sert deux fois, puisqu'il permet aussi de demander le solde à n'importe quelle
  date passée, ce dont se sert la courbe du tableau de bord.

### 3. Étage ouvert, texte libre chiffré, nombres en clair

Tout passe par `ctx.cipher()` (l'étage ouvert du SDK), comme l'audience et les
bases de données : le livre appartient à l'**espace**,
et tout membre d'un espace partagé doit pouvoir le lire sans dépendre de la
session de son propriétaire. La feature ne demande donc **jamais** de mot de
passe, et son manifest ne déclare aucune capacité de secret : ses seules
capacités natives sont `notify` (les rappels) et `routes.public` (le retour de
la banque après le consentement).

Ce qui est chiffré (`content`) : intitulé, tiers, note, nom de compte, nom de
catégorie. Ce qui reste en clair : montants, dates, natures, rattachements,
pointage, TVA.

La raison n'est pas le confort : un solde, une TVA et une répartition sont des
`SUM(...) GROUP BY`, et le chiffrement de DevEye est non déterministe. Rien de ce
sur quoi on agrège ne peut le traverser. L'alternative serait de télécharger
l'intégralité du journal dans le navigateur pour afficher un solde.

---

## Les échéances n'ont pas de tâche de fond

`postDueRecurring` (`src/server/_shared.ts`) est appelé **en tête de chaque
lecture** qui montre un montant, par `catchUp` (`src/server/sources.ts`). Il écrit
les occurrences dues des échéances automatiques, puis avance leur date.

Pourquoi pas un ordonnanceur : il aurait fallu un état en mémoire, un cycle de
vie, et une réponse à « que se passe-t-il si le serveur était éteint mardi ». Ici
il n'y a rien à ordonnancer : la première lecture qui suit la date écrit ce qui
manque, et rattrape autant de retard qu'il en reste. Le coût quand il n'y a rien
à faire, c'est-à-dire quasiment toujours, est **une** requête servie par
`idx_finance_recurring_due`.

Ce qui garantit qu'une occurrence n'est jamais écrite deux fois : l'index unique
`(recurring_id, date)`. Deux lectures simultanées tombent sur la même échéance en
retard ; la seconde insertion est refusée, traitée comme un succès, et les deux
avancent l'échéance à la même date. Le contrôle est dans la base, pas dans un
verrou applicatif qui ne survivrait pas à deux instances du serveur.

Le **jour d'ancrage** (`anchor_day`) est ce qui empêche une échéance au 31 de
dériver : sans lui, février la ramène au 28 et elle y reste pour toujours, parce
que le calcul suivant repartirait de cette date-là. Les cas sont couverts par
`src/server/calendar.test.ts`, et le rattrapage lui-même par
`handlers.test.ts` sur un faux dépôt.

Les deux contreparties sont assumées et documentées à côté du code : une lecture
peut écrire (y compris pour un membre en lecture seule), et une commande ne
diffuse rien aux autres connexions (le contexte d'une commande n'expose pas
`live.changed`, par construction). Le service de fond, lui, appelle aussi
`catchUp` avant de calculer un rappel.

**En ajoutant une lecture qui montre un solde ou un journal, il faut appeler
`catchUp`.** Six lectures le font (`finance.summary`, `finance.accountList`,
`finance.transactionList`, `finance.recurringList`, `finance.statementList`,
`finance.overview`), et l'import d'un relevé (`finance.statementImport`) avant
de rapprocher ; `finance.config` et `finance.categoryList` s'en passent, aucune
des deux ne portant de montant.

---

## Les recettes viennent de Facturation

Qui facture n'a pas à retaper ce qu'il vient d'encaisser. Chaque règlement saisi
dans Facturation arrive dans le livre, sur le compte qui les reçoit (un seul par
espace, `finance_config.invoicing_account_id`), rangé dans la catégorie choisie
(« Prestations » par défaut, créée au besoin). Facturation offre ce qu'il faut
par un fournisseur du SDK, `INVOICING_LEDGER_PROVIDER` : les règlements, les
factures qui attendent encore, la devise et le régime de TVA.

**Le livre lit Facturation, pas l'inverse.** `syncInvoicing` tourne à la lecture,
comme les échéances. Une écriture poussée par Facturation aurait demandé trois
mécanismes (l'écriture, un rattrapage pour le module absent ou le compte pas
encore choisi, une réparation quand l'une des deux écritures échoue sans
l'autre : il n'y a pas de transaction entre modules) ; la comparaison à la
lecture n'en demande qu'un, et elle converge toujours.

**Ce qu'elle coûte quand rien ne bouge** : la ligne de réglages, le compte, et la
version de Facturation (le nombre de règlements et le plus grand identifiant,
sur un index). La comparaison complète ne tourne que quand cette version, la
devise, le compte qui reçoit ou son jour de départ ont changé. Un règlement ne
fait qu'apparaître ou disparaître, et tout ce dont il dépend est figé à
l'émission de sa facture : la copie ne peut pas diverger en silence.

- Une copie porte `source = 'invoicing'` et l'identifiant du règlement ; l'index
  unique `(workspace_id, source, source_ref)` fait de deux lectures simultanées
  une seule copie.
- **Rien d'antérieur au jour de départ** du compte (`opened_on`) ne se recopie :
  le solde de départ le compte déjà. Déplacer ce jour retire les copies qui le
  précèdent.
- Un règlement dans **une autre devise** que celle de Facturation reste là-bas.
- Au **premier passage**, une recette déjà notée à la main (même compte, même
  montant, à trois jours près, et seule candidate) devient la copie au lieu
  d'être comptée deux fois. Deux candidates : aucune n'est choisie, le doublon
  reste visible.
- Une copie se **range** ici (compte, catégorie, pointage, note) mais ses **faits**
  (montant, date, TVA, intitulé) se corrigent dans Facturation, et elle ne se
  supprime pas ici : elle part avec son règlement.
- Sa **part de TVA** est celle que Facturation déclare (`paymentVatCents`), au
  centime près : les deux tableaux de bord disent la même chose.

**Ce que voit un membre** : qui lit Finances voit l'argent entré, donc le nom des
clients qui paient, même sans droit sur Facturation. Le nom figé sur la facture
devient le tiers de la copie. Le livre ne peut pas vérifier les restrictions
d'un autre module ; fermer Finances à un rôle reste le geste qui cache
l'argent.

L'accueil montre aussi **ce qui reste à encaisser** (les factures émises qui
attendent, les plus anciennes échéances d'abord) et une **prévision** sur le
mois en cours et les deux suivants : le solde du jour, plus les factures à leur
échéance (les retards comptés tout de suite), plus ou moins les échéances et ce
qui est déjà saisi à une date future. Le sujet `invoicing` ravive ces écrans en
direct (`alsoInvalidatedBy`) ; un membre qui lit Finances sans lire
Facturation ne reçoit pas ce battement et voit le règlement à sa lecture
suivante.

---

## Les relevés de la banque

Personne ne retape son relevé. Il s'**importe** (Relevés, ou la fiche d'un
compte), en CSV ou en OFX, et chaque ligne se **rapproche** : elle confirme une
opération déjà au livre, ou en devient une.

**Le fichier est lu dans le navigateur** (`src/client/statement/`). Aucun CSV ne
ressemble à un autre : séparateur, encodage (UTF-8 ou Windows-1252), lignes
avant l'en-tête, montant signé ou débit et crédit séparés, jour avant le mois.
La lecture devine les colonnes, les montre avec un aperçu, et la correspondance
validée est retenue pour le compte (`finance.importMapping`, dans `ctx.store`
sous `import:<compte>`) : le même export se relit ensuite sans rien demander. Le
serveur ne reçoit que des lignes normalisées, 2 000 au plus par envoi
(`STATEMENT_LINES_MAX`).

**Une ligne n'entre qu'une fois.** Son identité chez la banque (`external_id`,
unique par compte) est celle que la source donne : le `FITID` d'un OFX,
l'identifiant de l'opération chez Qonto, l'`entry_reference` chez Enable
Banking. Pour un CSV, c'est une empreinte HMAC du compte, du jour, du sens, du
montant, du libellé normalisé et du rang parmi les lignes identiques du même
fichier (deux cafés le même jour restent deux), sous une clé dérivée par le SDK
(`keys.derive`) : l'empreinte ne rend pas le libellé. Réimporter un relevé qui
chevauche le précédent n'ajoute que ce qui manque.

**Le rapprochement** (`src/server/reconcile.ts`) ne choisit jamais à la place de
la personne :

1. Une opération du livre au même compte, même sens, même montant, datée de
   cinq jours avant à trois jours après, et **seule candidate** : la ligne s'y
   rattache et l'opération est pointée. C'est ainsi qu'une copie de règlement,
   une échéance écrite ou une saisie se confirment.
2. Sinon, une **règle** (« le libellé contient ovh » → Hébergement) crée
   l'opération, pointée, avec sa TVA quand le régime la récupère.
3. Sinon la ligne attend dans Relevés, avec ce qu'elle pourrait être : les
   opérations candidates quand il y en a plusieurs (trois au plus), une échéance
   manuelle due au même montant, une facture qui attend exactement ce montant
   (sur le compte qui reçoit les règlements seulement).

Le moteur tourne à l'import, à chaque saisie, et quand des règlements de
Facturation arrivent : l'ordre (relevé d'abord, règlement ensuite, ou l'inverse)
ne change rien au résultat. « Encaisser » une facture depuis une ligne passe par
`INVOICING_CLIENT_PROVIDER` : c'est la commande de Facturation qui s'exécute,
sous la session de la personne, avec ses droits, son audit et son avis « facture
soldée » ; la copie arrive ensuite et confirme la ligne.

**Défaire un rapprochement** passe par l'opération. La corriger au point
qu'elle ne ressemble plus à sa ligne remet la ligne à rapprocher. La supprimer
**écarte** la ligne plutôt que de la remettre en attente, sinon la même règle la
recréerait aussitôt ; « Rétablir » la rend. Une copie qui disparaît avec son
règlement, elle, remet sa ligne en attente : l'argent est bien arrivé.

**Le solde de la banque**, quand le fichier le porte, est gardé par import et
comparé au solde pointé du livre à la même date. Au premier import dans un
compte vide, le solde de départ qu'il implique est **proposé**, jamais écrit
d'office.

---

## Les connexions bancaires

Une connexion relève les comptes d'une banque toutes les six heures
(`BANK_SYNC_HOURS`), sans fichier à exporter. Ce n'est **qu'une source de lignes
de relevé de plus** : les lignes relevées prennent le même chemin qu'un import
(identité unique par compte, puis `reconcile.ts`), et rien d'autre n'en sait
plus. Deux connecteurs, derrière la même interface (`src/server/banks/`,
`BankConnector` : comptes, lignes comptabilisées depuis un jour, solde) :

- **Qonto** (`banks/qonto.ts`), par la clé d'API de l'organisation (identifiant
  et clé secrète, en-tête `identifiant:clé` qui n'est pas du Basic). Lecture
  seule : la clé ne permet ni virement ni modification. Une clé que Qonto refuse
  ne s'enregistre pas (`finance.connectionAddQonto`).
- **Les autres banques par Enable Banking** (`banks/enableBanking.ts`), un
  agrégateur agréé (DSP2). Chaque appel est signé d'un jeton RS256 fait avec la
  clé de l'application de l'instance (voir plus bas) ; sans elle, « Autre
  banque » ne se propose pas. La personne consent chez sa banque dans une
  fenêtre à part (`src/client/bankWindow.ts`), qui revient sur la route publique
  `/api/finance/bank/callback` : le `state` est un ticket de session scellé par
  `finance.connectionStart` (trente minutes), la route ne fait que le reprendre.
  Le consentement a une fin, que la banque fixe (180 jours au plus sont
  demandés, `CONSENT_MAX_SECONDS`) : un avis part une semaine avant, puis à la
  fin, et « Reconnecter » renouvelle sans délier les comptes (retrouvés par
  l'`identification_hash` de la banque).

Les deux connecteurs sont exercés par `src/server/banking.test.ts` contre des
réponses HTTP simulées (`bankHttp.fetch` remplacé) : refus d'une clé, relève
sans doublon, rapprochement, offre, consentement et reconnexion, pagination,
avis de fin de consentement.

**Le patron des sources** ([Docs/SOURCES.md](../../Docs/SOURCES.md)) : les
connexions se créent, se corrigent et se retirent dans Réglages, Sources de la
feature ; un compte du livre en choisit une dans son onglet Banque, le « + »
ouvre les Sources par-dessus et adopte la connexion qui y naît. Le lien vit dans
`ft_finance_bank_links`, pas sur `finance_accounts`.

**Rien n'arrive deux fois.** Relier un compte fixe son premier jour relevé au
lendemain de la dernière ligne déjà importée (au solde de départ sinon) ; chaque
relève relit une semaine en arrière de la dernière ligne (`OVERLAP_DAYS`), et
l'identité d'une ligne écarte ce qui est déjà là. Seules les lignes
comptabilisées entrent : une opération en attente change encore. Chez Enable
Banking, la relève ne remonte pas au-delà de 89 jours (`PSD2_HISTORY_DAYS`), ce
qu'une banque rend sans redemander le consentement.

**Le service de fond** (`src/server/service.ts`) regarde toutes les quinze
minutes les connexions qui ont plus de six heures et en relève six de front au
plus par tour, pour borner la rafale d'appels sortants.

**Le solde de la banque** s'écrit comme celui d'un import (`format = 'bank'`),
seulement quand il apporte quelque chose : l'écart avec le livre pointé se lit
dans Relevés.

**Les accès** sont chiffrés à l'étage ouvert, comme les jetons GitHub : le
service de fond les lit sans session. Ils ne ressortent jamais, un secret laissé
vide à la correction est gardé. Retirer une connexion délie ses comptes, rend le
consentement chez Enable Banking, et laisse au livre ce qu'elle a apporté.

### Activer Enable Banking

Créer un compte sur enablebanking.com, puis une application de production en
mode **restreint** (gratuit : seuls les comptes que le propriétaire de
l'application relie lui-même s'ouvrent, ce qui convient à une instance pour
soi). Déclarer l'URI de redirection
`<origine de l'app>/api/finance/bank/callback`, garder la clé privée générée, et
poser `ENABLE_BANKING_APP_ID` et `ENABLE_BANKING_PRIVATE_KEY` (le PEM, retours à
la ligne écrits `\n`, ou son base64). Une seule des deux posée, ou une clé qui
ne se lit pas, s'annonce au démarrage.

---

## Ce qu'il faut mettre de côté

Le **statut** de l'activité (panneau Général) dit ce qui est dû sur l'argent
entré. Tout est estimé à partir du livre, et l'écran le dit : la déclaration
fait foi.

- **Micro-entreprise** : son activité (libéral, libéral CIPAV, services, vente),
  la cadence de ses déclarations, un taux choisi à la place du taux légal (l'ACRE)
  et le versement libératoire. Les taux, la formation professionnelle et les
  seuils vivent dans une table datée, `src/contracts/legal.ts`, avec leurs
  sources : une période passée se calcule au taux de son époque. **À relire à
  chaque loi de finances.**
- **Entreprise ou société** : la part du bénéfice à garder pour l'impôt et les
  cotisations, que son expert-comptable lui donne.

Deux façons de compter, selon ce que la loi rend prévisible :

- Les **cotisations d'une micro-entreprise** se comptent par période, sans rien
  demander : celles de la période en cours, plus celles de la période close tant
  que son échéance (la fin du mois qui suit) n'est pas passée. Après, on les
  suppose payées. La déclaration à faire est la période close encore due, sinon
  celle en cours ; son chiffre d'affaires est hors TVA, sans les recettes rangées
  hors chiffre d'affaires.
- La **TVA** et la **part du bénéfice** n'ont pas de calendrier aussi simple :
  elles s'additionnent depuis le jour de suivi (le début du mois où l'on a dit
  son statut, modifiable), moins ce qui a été versé depuis dans les catégories
  qui les paient.

C'est le **rôle d'une catégorie** qui dit ce qu'elle compte (`finance_categories.role`) :
une recette hors chiffre d'affaires (un remboursement), ou une dépense qui verse
des cotisations, des impôts ou de la TVA. Le jeu par défaut les pose.

L'accueil montre la déclaration à faire, ce qu'il faut mettre de côté, le
**disponible réel** (le solde, moins ce qui est dû), et le chiffre d'affaires de
l'année face au plafond de la micro-entreprise et à la franchise de TVA. La
prévision fait sortir les versements URSSAF au mois de leur échéance, et la carte
de l'accueil de l'app montre le disponible réel.

**Les rappels** et la relève des connexions bancaires sont le travail de fond du
module (`src/server/service.ts`). Un rappel part une semaine avant l'échéance
d'une déclaration, puis la veille, par les canaux de l'espace, avec le chiffre
d'affaires à déclarer. Une lecture ne sait pas quand minuit passe, d'où une
boucle ; `ft_finance_reminders` retient ce qui est parti, et un avis ne part
jamais deux fois, même à plusieurs instances. Aucun rappel ne vise un compte :
leur onglet Notifications n'existe pas (`notifications.perItem: false`).

## Les soldes

Trois par compte, et les confondre est la source d'erreur la plus courante d'un
livre de comptes :

| Champ       | Ce qu'il répond                                                  |
| ----------- | ---------------------------------------------------------------- |
| `balance`   | Ce qu'il y a **aujourd'hui**. Le solde, sans autre qualificatif. |
| `projected` | Le même, opérations déjà datées plus tard comprises.             |
| `cleared`   | Seulement ce qui a été **pointé**, donc vu sur le relevé.        |

Ils sont calculés en une passe par la CTE `mv` (« les mouvements, vus depuis le
compte qu'ils touchent »). Un **virement** y apparaît deux fois, une par côté,
avec le signe qui convient : c'est ce qui permet de le représenter par une seule
ligne au lieu d'une paire à garder cohérente.

Rien n'est jamais stocké : le seul nombre mémorisé est `initial_balance`, le
point où le livre commence. Tout le reste se déduit, pour qu'une correction d'une
opération d'il y a six mois se répercute d'elle-même.

**Les comptes archivés comptent dans les totaux.** Archiver range un compte, cela
ne fait pas disparaître ce qu'il contient. Les exclure ferait qu'archiver un
compte non soldé retirerait de l'argent du patrimoine sans qu'aucune opération ne
l'explique, et que la somme des cartes affichées ne retomberait plus sur le total
annoncé. Ils sortent seulement des sélecteurs de saisie.

---

## Les gardes qui protègent le livre

Toutes lèvent `conflict` ou `validation`, avec une phrase en français que le
client affiche telle quelle (`humanizeError`).

- **Supprimer un compte** est refusé tant qu'il porte une opération, une
  échéance ou une ligne de relevé. Son lien à une banque part avec lui. **L'archiver** est refusé tant qu'il reçoit les règlements de
  Facturation. Les clés étrangères sont en `CASCADE` : sans ces décomptes, de
  l'argent disparaîtrait d'un livre de comptes sans un mot. Le geste réversible
  existe déjà, c'est l'archivage.
- **Changer le sens d'une catégorie** est refusé : toutes les opérations déjà
  classées dessous deviendraient fausses, et la répartition compterait une sortie
  comme une entrée.
- **Un virement** ne porte ni catégorie ni TVA, et ne peut pas viser son propre
  compte de départ.
- **Redater une opération née d'une échéance** sur une occurrence déjà existante
  est refusé explicitement, plutôt que de laisser remonter l'erreur de contrainte.

---

## La TVA

La devise et le régime de TVA sont ceux de Facturation, qui en a besoin pour
émettre : le panneau Général de Finances les montre et renvoie à leur réglage.
Deux réglages au même nom dans deux features finiraient par se contredire. Sans
Facturation, le livre compte en euros, sans TVA.

Un seul drapeau (`vatEnabled`), et il n'ajoute aucun écran : il fait
apparaître la TVA sur les saisies et son récapitulatif (collectée, déductible, à
reverser) parmi les chiffres de l'accueil. Rien d'autre ne change, parce que rien
d'autre n'a besoin de changer.

La TVA se **saisit** par son taux (les quatre taux français, plus l'exonération)
mais se **stocke** en montant. Garder les deux ouvrirait la porte à un couple
incohérent que rien ne pourrait ensuite départager, et un taux exotique reste
saisissable en ajustant le montant.

---

## L'écran

Pas d'onglets, sur le modèle de Facturation : l'accueil porte les chiffres de la
période, les comptes, ce qui arrive et les dernières opérations, et « Voir tout »
ouvre les listes complètes (Opérations, Échéances, Relevés). Des lignes en
attente s'annoncent en tête de l'accueil. Un clic sur un compte ouvre
sa fiche : ses soldes, puis son journal.

Le **compte est l'élément** de la feature (`hasItems: true`, `itemNoun:
'compte'`). Le dialogue de création ne fait que créer ; le renommer, changer son
solde de départ, l'archiver ou le retirer se fait dans l'onglet Général de ses
réglages, au bout de la rangée d'en-tête de sa fiche
([Docs/SETTINGS.md](../../Docs/SETTINGS.md)). Une opération, elle, n'est pas un
élément : elle se corrige dans son dialogue.

L'écran est démonté dès sa fermeture (`cacheDurationMinutes: 0`) : les filtres
du journal n'ont pas à survivre, et des soldes en cache vieilliraient.

## Les réglages

Six panneaux dans la coquille commune ([Docs/SETTINGS.md](../../Docs/SETTINGS.md)),
déclarés par le manifest (`settings.feature` et `settings.item`) et fournis par
l'entrée client (`settingsPanels`) :

- **Général**, à l'échelle de la feature (`FinanceGeneralPanel`) : le statut de
  l'activité (`finance.statusSet`), puis la devise et la TVA, lues de
  Facturation, avec le lien vers leur réglage là-bas.
- **Général**, à l'échelle d'un compte (`AccountPanel`) : son identité, son solde
  de départ et le jour où il a été relevé, l'arrivée des règlements de
  Facturation (`finance.invoicingLink`), sa note, son archivage et son retrait.
  `GeneralPanel` aiguille entre les deux.
- **Catégories** (`FinanceCategoriesPanel`) : la grille de lecture. C'est le
  seul endroit où une catégorie se crée, se corrige, se retire (popup empilée,
  rangée canonique) ; le dialogue d'opération ne fait que choisir dedans, et
  mène à cet onglet quand il n'y a rien à choisir. Patron des sources
  ([Docs/SOURCES.md](../../Docs/SOURCES.md)).
- **Sources** (`FinanceSourcesPanel`, `ConnectionDialog`) : les connexions
  bancaires, seul endroit où elles se créent et se retirent, avec la limite de
  l'offre.
- **Banque**, à l'échelle d'un compte (`AccountBankPanel`) : la connexion qui
  l'alimente et le compte suivi chez la banque.
- **Règles** (`FinanceRulesPanel`) : celles qui rangent les lignes de relevé.
  Elles naissent surtout en rapprochant une ligne (« Ranger ainsi, à
  l'avenir ») ; ici elles se relisent, se corrigent et se retirent.

## Configuration

Lues par `src/server/env.ts` ; toutes deux facultatives.

| Variable                     | Défaut | Rôle                                                                                  |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `ENABLE_BANKING_APP_ID`      | vide   | l'application Enable Banking de l'instance ; vide, « Autre banque » ne se propose pas |
| `ENABLE_BANKING_PRIVATE_KEY` | vide   | sa clé privée, en PEM (retours à la ligne écrits `\n`) ou en base64 du PEM            |

Qonto et l'import de relevé marchent sans aucune des deux.

## Quotas, notifications, partage

- **L'offre** : `finance.bankConnections` est un stock qui compte les connexions
  bancaires des espaces du propriétaire (Gratuite 1, Pro 5, valeurs de
  `DevEye-Billing/src/server/plans.ts`) ; l'excédent se met en pause
  ([Docs/QUOTAS.md](../../Docs/QUOTAS.md)). Une connexion en pause ne se relève
  plus, ni à l'heure ni à la main. Le livre lui-même, ses comptes, ses opérations
  et l'import de relevé n'ont aucune limite. Le panneau Sources dit la limite
  avant tout refus. Une installation sans module de facturation n'a aucune
  limite.
- **Notifications** (`notifies: true`, `perItem: false`) : les rappels de
  déclaration URSSAF et l'avis de fin d'un consentement bancaire, par les canaux
  de l'espace.
- **Partage** : `shareTier: 'never'`. Un compte ne se projette pas vers un autre
  espace.

## Points d'entrée

| Rôle                                                    | Fichier                                                                                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest                                                | `src/manifest.ts`                                                                                                                                                                                                    |
| Schémas et types                                        | `src/contracts/domain.ts`                                                                                                                                                                                            |
| Contrats des 40 commandes, relevés, connexions          | `src/contracts/commands.ts`, `statement.ts`, `banking.ts`                                                                                                                                                            |
| Taux et calendrier légaux                               | `src/contracts/legal.ts` (et `legal.test.ts`)                                                                                                                                                                        |
| Schéma SQL d'origine, dans le socle                     | `src/db/migrations/084_finance.sql` de l'app (six tables `finance_*`, en allowlist dans `deveye-feature.json`)                                                                                                       |
| Évolutions du schéma                                    | `src/server/migrations/` : `001_pro.sql`, `002_invoicing_link.sql`, `003_status.sql`, `004_statements.sql`, `005_connections.sql` ; `uninstall.sql` ne retire que les tables `ft_finance_*`                          |
| Requêtes                                                | `src/server/repo.ts`                                                                                                                                                                                                 |
| Socle serveur (chiffre, calendrier, gardes, rattrapage) | `src/server/_shared.ts`                                                                                                                                                                                              |
| Recopie des règlements de Facturation                   | `src/server/sources.ts`                                                                                                                                                                                              |
| Rapprochement des relevés et règles                     | `src/server/reconcile.ts`                                                                                                                                                                                            |
| Connexions bancaires, relève, retour de la banque       | `src/server/banking.ts`, `banks/{types,qonto,enableBanking}.ts`, `routes.ts`, `env.ts`                                                                                                                               |
| Statut, provisions, seuils                              | `src/server/status.ts`                                                                                                                                                                                               |
| Rappels de déclaration, relève et avis des connexions   | `src/server/service.ts`                                                                                                                                                                                              |
| Handlers (un fichier par nature)                        | `src/server/handlers/` (`config`, `accounts`, `categories`, `transactions`, `recurring`, `statements`, `connections`, `overview`)                                                                                    |
| Export du compte                                        | `src/server/accountExport.ts`                                                                                                                                                                                        |
| Tests serveur, faux dépôt                               | `src/server/*.test.ts` (`handlers`, `calendar`, `sources`, `reconcile`, `banking`, `status`, `accountExport`), `src/server/_testing.ts`                                                                              |
| Lecture des CSV et OFX, dans le navigateur              | `src/client/statement/` (`csv.ts`, `ofx.ts`, `keyword.ts`, `statement.test.ts`)                                                                                                                                      |
| Entrée client, panneaux de réglages                     | `src/client/index.tsx`, `src/client/*Panel.tsx`, `ConnectionDialog.tsx`                                                                                                                                              |
| Coquille, accueil, pages et fiche                       | `src/client/Finance.tsx`, `Home.tsx`, `TransactionsPage.tsx`, `RecurringPage.tsx`, `ReviewPage.tsx`, `AccountSheet.tsx`, `shared.ts`                                                                                 |
| Journal et dialogues                                    | `src/client/Journal.tsx`, `TransactionRow.tsx`, `TransactionDialog.tsx`, `RecurringDialog.tsx`, `PostDialog.tsx`, `ImportDialog.tsx`, `ResolveDialog.tsx`, `AccountDialog.tsx`, `AccountGrid.tsx`, `ColorPicker.tsx` |
| Graphiques, fenêtre de la banque, carte d'accueil       | `src/client/Charts/`, `bankWindow.ts`, `FinanceWidget.tsx`                                                                                                                                                           |
| Mise en forme et vocabulaire                            | `src/client/format.ts`                                                                                                                                                                                               |

## Tests

```bash
npm run test:features
```
