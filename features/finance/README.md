# Finances

La trésorerie d'une activité : ses comptes, ses opérations, ses échéances, et la
TVA quand elle est suivie. Elle s'adresse à qui facture des clients (un
freelance, une petite agence), pas à la gestion d'un budget personnel.

Ce document dit **pourquoi** la feature est faite ainsi. Le « quoi » est dans les
schémas (`src/contracts/domain.ts`) et le « comment » dans le code, qui est
commenté. C'est un **module in-repo** sur le SDK des features
(`Docs/FEATURE_SDK.md`) : ses contrats, son dépôt, ses handlers et son client
vivent tous ici, et `@deveye/types` n'en garde que l'identité.

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
passe, et son manifest ne déclare aucune capacité native.

Ce qui est chiffré (`content`) : intitulé, tiers, note, nom de compte, nom de
catégorie. Ce qui reste en clair : montants, dates, natures, rattachements,
pointage, TVA.

La raison n'est pas le confort : un solde, une TVA et une répartition sont des
`SUM(...) GROUP BY`, et le chiffrement de DevEye est non déterministe. Rien de ce
sur quoi on agrège ne peut le traverser. L'alternative serait de télécharger
l'intégralité du journal dans le navigateur pour afficher un solde.

---

## Les échéances n'ont pas de tâche de fond

`postDueRecurring` (`features/finance/src/server/_shared.ts`) est appelé **en
tête de chaque lecture** qui montre un montant. Il écrit les occurrences dues des échéances
automatiques, puis avance leur date.

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
`features/finance/src/server/calendar.test.ts`, et le rattrapage lui-même par
`handlers.test.ts` sur un faux dépôt (`npm run test:features`).

Les deux contreparties sont assumées et documentées à côté du code : une lecture
peut écrire (y compris pour un membre en lecture seule), et rien n'est diffusé
aux autres connexions (le contexte d'une commande n'expose pas `live.changed`,
par construction ; seul un service de fond du module l'aurait).

**En ajoutant une lecture qui montre un solde ou un journal, il faut appeler
`postDueRecurring`.** Cinq lectures le font ; `finance.config` et
`finance.categoryList` s'en passent, aucune des deux ne portant de montant.

---

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

- **Supprimer un compte** est refusé tant qu'il porte une opération ou une
  échéance. Les deux clés étrangères sont en `CASCADE` : sans ces décomptes, de
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

Un seul commutateur (`vatEnabled`), et il n'ajoute aucun écran : il fait
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
ouvre les listes complètes (Opérations, Échéances). Un clic sur un compte ouvre
sa fiche : ses soldes, puis son journal.

Le **compte est l'élément** de la feature (`hasItems: true`, `itemNoun:
'compte'`). Le dialogue de création ne fait que créer ; le renommer, changer son
solde de départ, l'archiver ou le retirer se fait dans l'onglet Général de ses
réglages, au bout de la rangée d'en-tête de sa fiche (`Docs/SETTINGS.md`). Une
opération, elle, n'est pas un élément : elle se corrige dans son dialogue.

## Les réglages

Trois panneaux dans la coquille commune (`Docs/SETTINGS.md`), déclarés par le
manifest (`settings.feature` et `settings.item`) et fournis par l'entrée client
(`settingsPanels`) :

- **Général**, à l'échelle de la feature (`FinanceGeneralPanel`) : la devise et
  le suivi de la TVA (`finance.config` / `finance.configUpdate`). Après
  enregistrement, toutes les clés de la feature sont ravivées : le socle porte le
  symbole de chaque montant.
- **Général**, à l'échelle d'un compte (`AccountPanel`) : son identité, sa note,
  son archivage et son retrait. `GeneralPanel` aiguille entre les deux.
- **Catégories** (`FinanceCategoriesPanel`) : la grille de lecture. C'est le
  seul endroit où une catégorie se crée, se corrige, se retire (popup empilée,
  rangée canonique) ; le dialogue d'opération ne fait que choisir dedans, et
  mène à cet onglet quand il n'y a rien à choisir. Patron des sources
  (`Docs/SOURCES.md`).

## Points d'entrée

| Rôle                                                    | Fichier                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| Manifest                                                | `src/manifest.ts`                                                     |
| Schémas et types                                        | `src/contracts/domain.ts`                                             |
| Contrats des 24 commandes                               | `src/contracts/commands.ts`                                           |
| Schéma SQL d'origine, dans le socle                     | `DevEye/src/db/migrations/084_finance.sql`                            |
| Évolutions du schéma                                    | `src/server/migrations/`                                              |
| Requêtes                                                | `src/server/repo.ts`                                                  |
| Socle serveur (chiffre, calendrier, gardes, rattrapage) | `src/server/_shared.ts`                                               |
| Handlers (un fichier par nature)                        | `src/server/handlers/`                                                |
| Tests (calendrier, handlers)                            | `src/server/calendar.test.ts`, `src/server/handlers.test.ts`          |
| Entrée client, panneaux de réglages                     | `src/client/index.tsx`, `src/client/*Panel.tsx`                       |
| Coquille, accueil, pages et fiche                       | `src/client/Finance.tsx`, `Home.tsx`, `*Page.tsx`, `AccountSheet.tsx` |
| Mise en forme et vocabulaire                            | `src/client/format.ts`                                                |
