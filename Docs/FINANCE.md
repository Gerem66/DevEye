# Finances

Le grand livre d'un espace : comptes, opérations, budgets, échéances. Le même
objet pour un particulier et pour une PME, la TVA en plus quand on l'allume.

Ce document dit **pourquoi** la feature est faite ainsi. Le « quoi » est dans les
schémas (`features/finance/src/contracts/domain.ts`) et le « comment » dans le
code, qui est commenté.

Depuis le 27 août 2026, Finances est un **module in-repo** sur le SDK des
features (`DevEye/features/finance`, voir `FEATURE_SDK.md`) : ses contrats, son
dépôt, ses handlers et son client vivent tous dans ce répertoire, et
`@deveye/types` n'en garde que l'identité (l'id, le descripteur du registre).

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

Tout passe par `ctx.cipher()` (l'étage ouvert du SDK, l'ex `ctx.secure.open`),
comme l'audience et les bases de données : le livre appartient à l'**espace**,
et tout membre d'un espace partagé doit pouvoir le lire sans dépendre de la
session de son propriétaire. La feature ne demande donc **jamais** de mot de
passe, et son manifest ne déclare aucune capacité native.

Ce qui est chiffré (`content`) : intitulé, tiers, note, nom de compte, nom de
catégorie. Ce qui reste en clair : montants, dates, natures, rattachements,
pointage, TVA.

La raison n'est pas le confort : un solde, un budget et une répartition sont des
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

> ⚠️ **En ajoutant une lecture qui montre un solde, un journal ou un budget, il
> faut appeler `postDueRecurring`.** Six lectures le font ; `finance.config` et
> `finance.categoryList` s'en passent, aucune des deux ne portant de montant.

---

## Les soldes

Trois par compte, et les confondre est la source d'erreur la plus courante d'un
livre de comptes :

| Champ       | Ce qu'il répond                                                |
| ----------- | -------------------------------------------------------------- |
| `balance`   | Ce qu'il y a **aujourd'hui**. Le solde, sans autre qualificatif. |
| `projected` | Le même, opérations déjà datées plus tard comprises.            |
| `cleared`   | Seulement ce qui a été **pointé**, donc vu sur le relevé.       |

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
- **Un budget sur une catégorie de recettes** est refusé : se fixer un plafond de
  revenus n'est pas une notion de gestion.
- **Un virement** ne porte ni catégorie ni TVA, et ne peut pas viser son propre
  compte de départ.
- **Redater une opération née d'une échéance** sur une occurrence déjà existante
  est refusé explicitement, plutôt que de laisser remonter l'erreur de contrainte.

---

## Le mode entreprise

Un seul commutateur (`vatEnabled`), et il n'ajoute aucun écran : il fait
apparaître la TVA sur les saisies et son récapitulatif collectée / déductible sur
le tableau de bord. Rien d'autre ne change, parce que rien d'autre n'a besoin de
changer.

La TVA se **saisit** par son taux (les quatre taux français, plus l'exonération)
mais se **stocke** en montant. Garder les deux ouvrirait la porte à un couple
incohérent que rien ne pourrait ensuite départager, et un taux exotique reste
saisissable en ajustant le montant.

---

## Les réglages

Deux panneaux dans la coquille commune (`Docs/SETTINGS.md`), déclarés par le
manifest (`settings.feature: ['general', { id: 'categories', ... }]`) et
fournis par l'entrée client (`settingsPanels`) :

- **Général** (`FinanceGeneralPanel`) : la devise et le mode entreprise
  (`finance.config` / `finance.configUpdate`). Après enregistrement, toutes les
  clés de la feature sont ravivées : le socle porte le symbole de chaque montant.
- **Catégories** (`FinanceCategoriesPanel`) : la grille de lecture. C'est le
  seul endroit où une catégorie se crée, se corrige, se retire ; les fiches
  d'opération et de budget ne font que choisir dedans, et montent le bouton
  commun (`FeatureSettingsButton`, « Catégories ») quand il n'y a rien à
  choisir. Patron des sources (`Docs/SOURCES.md`).

## Points d'entrée

Tout vit dans `DevEye/features/finance/` (module in-repo).

| Rôle                          | Fichier                                     |
| ----------------------------- | ------------------------------------------- |
| Manifest                      | `src/manifest.ts`                           |
| Schémas et types              | `src/contracts/domain.ts`                   |
| Contrats des 28 commandes     | `src/contracts/commands.ts`                 |
| Schéma SQL (socle, jamais déplacé) | `DevEye/src/db/migrations/084_finance.sql` |
| Requêtes                      | `src/server/repo.ts`                        |
| Socle serveur (chiffre, calendrier, gardes, rattrapage) | `src/server/_shared.ts` |
| Handlers (un fichier par nature) | `src/server/handlers/`                   |
| Tests (calendrier, handlers)  | `src/server/calendar.test.ts`, `src/server/handlers.test.ts` |
| Entrée client, panneaux de réglages | `src/client/index.tsx`, `src/client/Finance*Panel.tsx` |
| Coquille et onglets           | `src/client/Finance.tsx`                    |
| Mise en forme et vocabulaire  | `src/client/format.ts`                      |
