# Convertisseur

Convertir une vidéo, un son, une image ou un document sans confier le fichier à
un site inconnu ni apprendre les arguments de `ffmpeg`. Un assistant en quatre
étapes (type, formats, options, export), des réglages aux défauts cohérents,
la taille finale annoncée avant l'export, et deux convertisseurs directs :
devises et unités.

## La carte

| Où                            | Quoi                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/contracts/catalogue.ts`  | **Le** fichier des formats : familles, sources, cibles, réglages, recettes                                 |
| `src/contracts/options.ts`    | La forme d'un réglage (`slider`, `segments`, `toggle`, `size`, `crop`…)                                    |
| `src/contracts/estimate.ts`   | La taille avant export, et l'arithmétique de la taille cible                                               |
| `src/contracts/units.ts`      | Les unités physiques et la parité de deux devises, calcul pur                                              |
| `src/server/handlers.ts`      | Les neuf commandes `convert.*` : capacités, liste, création, annulation, retrait, descente, taux, réglages |
| `src/server/routes.ts`        | La montée du fichier en flux et la descente du résultat, à ticket                                          |
| `src/server/service.ts`       | La file (un travail à la fois), l'avancement, l'avis de fin, l'entretien, les taux de change               |
| `src/server/repo.ts`          | Les travaux et leurs transitions d'état, les taux                                                          |
| `src/server/spawn.ts`         | Le lanceur d'outils : budget, veille d'arrêt, plafond de sortie                                            |
| `src/server/engines/`         | Un moteur par outil : ffmpeg, ImageMagick, LibreOffice et les outils PDF                                   |
| `src/server/storage.ts`       | Le disque : chemins, place libre, balayage                                                                 |
| `src/server/env.ts`           | Les variables `CONVERT_*` et leurs défauts                                                                 |
| `src/server/migrations/`      | `001` : les travaux, les taux de change et leur état de relecture                                          |
| `src/server/accountExport.ts` | L'export du compte                                                                                         |
| `src/server/testing.ts`       | Le dépôt en mémoire des tests, qui tient les mêmes gardes que le SQL                                       |
| `policy/policy.xml`           | La politique ImageMagick, copiée dans l'image par le Dockerfile                                            |
| `src/client/`                 | L'assistant, la file des travaux, devises, unités, réglages                                                |

## Ajouter un format

Une entrée dans `CATALOGUE`, et rien d'autre : l'écran rend les réglages d'après
leur forme, le moteur compose ses arguments d'après la recette. Une source dit
son groupe et ses lecteurs (`readers` : le démultiplexeur de ffmpeg ou le codeur
d'ImageMagick sous lequel le fichier DOIT être reconnu) ; une cible dit de quels
groupes elle part, ses réglages, et sa recette. `contracts.test.ts` tient ce que
le typage ne garde pas : identifiants uniques, réglages conditionnés à un réglage
qui existe, aucune source sans cible.

## Le parcours d'un travail

```
awaiting_upload → uploading → queued ⇄ running → done → expired
       ↓              ↓          ↓         ↓
    expired         error      error     error

canceled : depuis tout état avant done
```

`convert.create` ouvre le travail et rend une adresse de montée à ticket. Le
fichier monte en `POST` brut (`postStream` du SDK), est relu par l'outil de sa
famille, puis part en file. Le résultat se télécharge par une seconde adresse à
ticket, et quitte le disque à l'échéance. L'original part dès la conversion finie.

Un envoi jamais venu expire aussi (`CONVERT_UPLOAD_TTL_SECONDS`) : un onglet
fermé au mauvais moment ne tient pas pendant des heures la seule place d'une
offre gratuite. Un travail interrompu par un arrêt du serveur repasse en file,
`CONVERT_MAX_ATTEMPTS` fois au plus, puis passe en échec (`interrupted`) ; un
envoi coupé en pleine réception passe en échec (`upload_interrupted`), un fichier
tronqué n'ayant rien à reprendre. L'annulation (`convert.cancel`) vaut à toute
étape avant `done`. Un travail au repos (`done`, `error`, `canceled`,
`expired`) se retire de la liste (`convert.remove`).

Un avis part à la fin d'un travail assez long pour qu'on ait quitté l'écran
(`announce()` dans `service.ts`) : le nom du fichier converti, les formats, les
tailles et le temps qui reste pour le récupérer. Le seuil se règle dans Réglages
→ Général (Toujours, après 1, 5 ou 15 minutes ; une minute par défaut), les
canaux dans Réglages → Notifications. Une conversion plus courte que le seuil
reste silencieuse : on est encore devant l'écran.

## Les invariants

- **Tout outil tourne hors du processus du serveur**, sans shell, avec un
  environnement réduit à quatre variables : celui du serveur porte les clés de
  chiffrement. C'est ce qui écarte toute bibliothèque de décodage en processus.
- **Le nom d'un fichier envoyé ne touche jamais le disque ni le journal d'audit.**
  Les chemins ne contiennent que des entiers (`ws-<espace>/<travail>/in.bin`) ;
  le nom vit scellé en base, comme le message d'un échec, qui le cite.
- **Un fichier est ce que l'outil reconnaît, pas ce que son nom annonce.** Une
  liste de lecture (HLS, concat) référence d'autres fichiers : elle n'est le
  lecteur d'aucune source, donc refusée.
- **Chaque transition d'état est un `UPDATE … WHERE phase = <attendue>`.** Le
  ticket de montée est rejouable tant qu'il vit : c'est la ligne qui interdit
  deux envois.
- **Un état qui promet un fichier se vérifie contre le disque**, au démarrage, à
  chaque entretien et à la descente : un stockage vidé donne des travaux en échec
  `file_lost`, jamais des résultats « prêts » introuvables. Un stockage
  injoignable, lui, ne déclare rien de perdu.
- **Le lecteur de l'aperçu est maison** (`client/Player.tsx`) : ses commandes
  restent hors de l'image, qui se recadre ainsi en CSS comme elle le sera, et la
  lecture se borne au passage gardé. Rien n'est encodé : définition, cadence et
  qualité d'une vidéo ne se voient qu'au résultat.
- **Un recadrage est quatre marges, pas un rectangle** (`top`, `right`, `bottom`,
  `left`). Elles se règlent sans connaître les dimensions du fichier, que le
  navigateur ne lit pas toujours, et c'est le serveur qui les applique aux
  vraies (`cropRect`), en laissant toujours deux pixels par côté.
- **L'aperçu ne quitte pas le poste.** Image, vidéo, son et PDF se lisent dans le
  navigateur par une adresse `blob:` (d'où `media-src` et `frame-src` dans la CSP
  de l'app) ; la comparaison avant / après réutilise l'essai d'encodage qui sert
  déjà à peser le résultat. Rien ne monte avant le clic sur Exporter.
- **L'étape Export suit le travail qu'elle a lancé** : envoi, file, conversion,
  puis téléchargement. Les étapes d'avant restent fermées tant qu'il n'a pas
  échoué ; le retour en en-tête repart de zéro et laisse le travail finir dans la
  liste de l'accueil.
- **Un réglage peut s'ajuster au fichier** (`client/adaptOptions.ts`) : la qualité
  d'un JPEG se lit dans sa table de quantification (`client/jpegQuality.ts`), et
  le curseur part dessous, faute de quoi « compresser » alourdirait.
- **Une conversion est personnelle.** Un membre ne voit que les siennes, même
  dans un espace partagé.
- **Ce qu'un fichier peut peser** : le mur du serveur (`CONVERT_MAX_FILE_BYTES`),
  l'offre du propriétaire de l'espace (`convert.fileBytes`), et la place libre.
- **Ce qu'une offre borne en plus** ([`Docs/QUOTAS.md`](../../Docs/QUOTAS.md)),
  tous espaces du propriétaire confondus : les conversions ouvertes à la fois
  (`convert.activeJobs`, la file étant commune à tout le serveur) et le poids des
  résultats en attente de téléchargement (`convert.resultBytes`). Ce dernier ne
  se connaît qu'à la fin : la création refuse quand la réserve est déjà pleine,
  et la conversion s'arrête d'elle-même si son résultat la dépasse. Les clés du
  manifest sont `fileBytes` (par opération), `activeJobs` et `resultBytes` ; les
  valeurs sont celles du module de facturation des comptes (`src/server/plans.ts`
  de Billing) : 100 Mo par fichier, 1 conversion à la fois et 500 Mo de
  résultats en offre gratuite ; 2 Go, 5 et 2 Go en Pro. Une installation sans
  module de facturation n'a aucune limite.
- **`policy.xml` : ni apostrophe ni guillemet dans un commentaire.** Le lecteur
  XML d'ImageMagick les prend pour un début de chaîne et avale en silence les
  règles qui suivent. `policy.test.ts` le garde ; après une retouche, relire le
  résultat avec `magick -list policy`.

## L'exploitation

Les variables `CONVERT_*` sont décrites dans `.env.template`, leurs défauts dans
`src/server/env.ts`. Au démarrage le service sonde ses outils : une absence ne
l'empêche pas de démarrer, elle retire des formats de l'écran en nommant ce qui
manque (`convert.capabilities`). L'image se construit sans LibreOffice par
`--build-arg WITH_DOCUMENTS=0`.

## Tests

```bash
npm run test:features
```

depuis `DevEye/`.
