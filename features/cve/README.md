# Veille CVE : ce qui touche ce que l'espace fait tourner

Module in-repo (`features/cve`) : contrats dans `src/contracts/`, catalogue,
veille et handlers dans `src/server/`, écrans dans `src/client/`. L'app ne
garde que l'identité (`cve` dans le registre publié), et les contrats que le
module consomme (`GIT_ITEMS_PROVIDER`, `DATABASE_ITEMS_PROVIDER`,
`DEPLOY_ITEMS_PROVIDER`, `PROJECTS_USAGE_PROVIDER`) ou publie (`CVE_EXPOSURE_PROVIDER`, ce
que la veille sait d'un dépôt, que lit Audit), dans
`sdk/providers.ts` de `@deveye/types`. Voir
[Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md).

Deux moitiés :

- **Le catalogue**, commun à tout le serveur : le fil du NVD, ingéré toutes les
  trente minutes, la recherche, les épinglées de chaque espace.
- **La veille de l'espace** : un inventaire de ce que l'espace fait tourner,
  confronté aux catalogues, et des constats qui en sortent.

---

## 1. L'inventaire

Un **élément suivi** (`ft_cve_assets`) est un élément d'une autre feature que la
veille lit. Il naît et disparaît avec son élément, sans geste : la veille
rapproche ses lignes de sa source à chaque passage (`exposure/sources.ts`).

| Source       | Ce qui se lit                                                            | Comment                                      |
| ------------ | ------------------------------------------------------------------------ | -------------------------------------------- |
| Dépôts Git   | verrous, Dockerfile, compose, fichiers de version                        | `readFiles` de Git, sans clone               |
| Appareils    | système (pour sa fin de vie), moteur Docker/Podman, image des conteneurs | rapport de l'agent, `agents.dockerInventory` |
| Bases        | version du serveur (MySQL, MariaDB, PostgreSQL)                          | `listHome` de Bases, son dernier relevé      |
| Déploiements | image d'une application Dokploy de source Docker, fichier d'un compose   | `inventoryOf` de Déploiements                |

Une machine de Déploiements dit ses conteneurs par l'appareil, un workflow son
dépôt par Git : seul Dokploy est lu par Déploiements. Les projets ne sont pas
une source, ils étiquettent les éléments touchés (filtre « Projet »). Chaque
source se coupe dans l'onglet Détection ; coupée, elle ne compte plus nulle
part.

Un dépôt se lit **sans clone** : `readFiles` de Git demande l'arbre de la tête
puis les seuls fichiers reconnus (verrous, Dockerfile, compose, fichiers de
version), en sautant `node_modules/` et `vendor/`. Les lecteurs sont dans
`src/server/inventory/`, fonctions pures ; la liste de ce qu'ils savent lire
est `EXPOSURE_FORMATS` (`src/contracts/formats.ts`), ce que l'onglet
Inventaire montre sous « Formats reconnus ».

L'inventaire est **scellé** par le chiffre de l'espace (`summary_enc`,
`inventory_enc`) : il dit ce qu'un dépôt privé contient. Seules les empreintes
des produits employés sont en clair (`ft_cve_asset_keys`), pour qu'une CVE
fraîchement ingérée trouve les espaces qu'elle peut toucher sans rien
déchiffrer.

## 2. Les correspondances

| Constat                 | Catalogue                     | Ce qui est comparé                                             |
| ----------------------- | ----------------------------- | -------------------------------------------------------------- |
| Faille (`vuln`)         | OSV.dev, en lot, cache commun | les paquets des verrous, à leur version exacte                 |
| Faille (`vuln`)         | le NVD, catalogue local       | les produits (nginx, Node, PostgreSQL…), à leur version exacte |
| Fin de vie (`eol`)      | endoflife.date, dump du jour  | la branche de tout produit, système ou paquet déclaré          |
| Déprécié (`deprecated`) | deps.dev (et RustSec par OSV) | la version d'une dépendance directe                            |
| En retard (`outdated`)  | deps.dev                      | la majeure d'une dépendance directe contre la dernière publiée |

Les produits que la veille sait reconnaître (`TOOLS`, `inventory/tools.ts`)
sont inscrits dans `ft_cve_watched` au démarrage : leur historique entier est
rattrapé une fois, sinon une version ancienne ne trouverait pas ses CVE
anciennes. Seule une **version exacte** se compare aux failles : `nginx:1.25`
suit une branche, on ne sait pas quel correctif tourne ; il garde un
composant « de branche » (`exact: false`) qui ne sert qu'à la fin de vie.

Une **dépendance directe** est un paquet qu'un manifeste du dossier de son
verrou déclare (`package.json`, `Cargo.toml`, `pyproject.toml`, `Gemfile`,
`go.mod` sans `// indirect`, tout `requirements.txt`) : seule elle est
demandée à deps.dev (cent par évaluation au plus, le reste au passage
suivant), et seule elle a une fin de vie de paquet (un framework). Une fin
de vie se signale trente jours avant, puis quand elle est atteinte.

## 3. Les constats

Un constat (`ft_cve_findings`) est **un sujet dans un espace** : une faille sur
un paquet, quel que soit le nombre d'éléments qu'elle touche. Les éléments
touchés sont dans `ft_cve_finding_assets`, en clair, pour que le décompte
filtre par droits sans déchiffrer.

`exposure/reconcile.ts`, fonction pure, décide des transitions :

- **ouvert** au premier croisement ;
- **résolu** quand plus rien n'est touché ; il reste visible trente jours ;
- **rouvert** quand il revient, ou quand un élément qu'une décision
  d'« ignorer » n'avait pas vu se met à être touché ;
- **jamais résolu par un catalogue muet** : quand OSV ne répond pas ou que le
  NVD rattrape encore un historique, les constats qu'il avait établis restent
  tels quels, et l'écran le dit.

## 4. La cadence

Un passage toutes les cinq minutes (`exposure/engine.ts`) :

1. il rapproche les éléments de leurs sources ;
2. il lit, par source, les éléments dus (six au plus pour ce qui sort au
   dehors) : jamais lus, relecture demandée, en échec depuis une heure, puis
   selon la source : tête du dépôt changée (un jour sans tête connue),
   système de l'appareil changé ou six heures écoulées, version du serveur
   changée, six heures pour un déploiement ;
3. il réévalue les espaces marqués : inventaire changé, CVE ingérée sur l'un de
   leurs produits, ou dernière évaluation plus vieille que la fraîcheur du
   cache d'OSV (six heures).

Un élément inchangé ne coûte aucun appel extérieur. Un dépôt en pause chez Git
(au-delà de l'offre), comme une base ou une cible en pause, n'est pas lu.
Un appareil hors ligne garde son inventaire d'avant.

## 5. Droits

Un membre ne voit un élément, et les constats qui le touchent, que s'il peut
voir l'élément chez sa feature (`authorize` du provider, la liste des
appareils pour un appareil). Un constat dont
aucun élément n'est visible est caché, et la carte de l'accueil ne le compte
pas. Ignorer, rétablir, relire et sortir un élément de la veille demandent
l'écriture.
