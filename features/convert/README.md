# Convertisseur

Convertir une vidéo, un son, une image ou un document sans confier le fichier à
un site inconnu ni apprendre les arguments de `ffmpeg`. Un assistant en quatre
étapes (type, formats, options, export), des réglages aux défauts cohérents,
la taille finale annoncée avant l'export, deux convertisseurs directs (devises
et unités), et un atelier PDF qui travaille dans le navigateur.

## La carte

| Où                            | Quoi                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/contracts/catalogue.ts`  | **Le** fichier des formats : familles, sources, cibles, réglages, recettes                                        |
| `src/contracts/options.ts`    | La forme d'un réglage (`slider`, `segments`, `toggle`, `size`, `crop`…)                                           |
| `src/contracts/estimate.ts`   | La taille avant export, et l'arithmétique de la taille cible                                                      |
| `src/contracts/units.ts`      | Les unités physiques et la parité de deux devises, calcul pur                                                     |
| `src/contracts/signatures.ts` | Une signature gardée sur le compte, telle qu'elle voyage et se stocke                                             |
| `src/server/handlers.ts`      | Les commandes `convert.*` : capacités, liste, création, annulation, retrait, descente, taux, réglages, signatures |
| `src/server/routes.ts`        | La montée du fichier en flux et la descente du résultat, à ticket                                                 |
| `src/server/service.ts`       | La file (un travail à la fois), l'avancement, l'avis de fin, l'entretien, les taux de change                      |
| `src/server/repo.ts`          | Les travaux et leurs transitions d'état, les taux, les signatures gardées                                         |
| `src/server/spawn.ts`         | Le lanceur d'outils : budget, veille d'arrêt, plafond de sortie                                                   |
| `src/server/engines/`         | Un moteur par outil : ffmpeg, ImageMagick, LibreOffice, les outils PDF et ocrmypdf                                |
| `src/server/storage.ts`       | Le disque : chemins, place libre, balayage                                                                        |
| `src/server/env.ts`           | Les variables `CONVERT_*` et leurs défauts                                                                        |
| `src/server/migrations/`      | `001` : les travaux, les taux de change et leur état de relecture ; `002` : les signatures gardées                |
| `src/server/accountExport.ts` | L'export du compte                                                                                                |
| `src/server/e2e.ts`           | Le scénario de la page Tests et débogage : une signature gardée, relue, retirée                                   |
| `src/server/testing.ts`       | Le dépôt en mémoire des tests, qui tient les mêmes gardes que le SQL                                              |
| `policy/policy.xml`           | La politique ImageMagick, copiée dans l'image par le Dockerfile                                                   |
| `src/client/`                 | L'assistant, la file des travaux, devises, unités, réglages                                                       |
| `src/client/pdf/`             | L'atelier PDF : voir ci-dessous                                                                                   |

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

## L'atelier PDF

Tout se fait dans le navigateur : les fichiers ne montent pas, et rien ne coûte
au serveur, donc aucun quota. pdf.js affiche les pages, lit le texte et les
champs ; pdf-lib (le fork maintenu de Cantoo) assemble le document dans un
worker ; le résultat se télécharge depuis une adresse `blob:`. Le serveur ne
sert qu'à ce que le navigateur ne sait pas faire, l'allègement (Ghostscript) et
la reconnaissance du texte d'un scan (ocrmypdf), par le parcours de travaux
ordinaire : l'atelier assemble le document, puis le confie à l'assistant à
l'étape des options.

| Où                                       | Quoi                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `model.ts`                               | Le plan des pages (fichiers, images, pages blanches), ses opérations, calcul pur           |
| `usePdfWorkshop.ts`                      | L'état : plan, éléments posés, champs, finitions, sélection, annuler et rétablir           |
| `elements.ts`                            | Ce qu'on pose sur une page (signature, texte, coche, image, surlignage, trait, caviardage) |
| `geometry.ts`                            | Du cadre affiché au repère du fichier, rotation et origine de la boîte comprises           |
| `build.ts`, `build.worker`               | L'assemblage par pdf-lib : pages, formulaire, éléments, finitions, mot de passe            |
| `finishing.ts`                           | Numéros de page, filigrane, propriétés, mot de passe                                       |
| `fields.ts`, `text.ts`                   | Les champs d'un formulaire et le texte d'une page, lus dans ce que pdf.js livre            |
| `documents.ts`                           | Les fichiers ouverts, hors de React : octets, document pdf.js, images posées               |
| `pdfjs.ts`, `thumbnails.ts`, `raster.ts` | pdf.js chargé à la demande, les vignettes en file, la page caviardée en image              |
| `split.ts`, `zip.ts`                     | Le découpage en parties et l'archive                                                       |
| `savedSignatures.ts`                     | Les signatures gardées sur le compte, avec leur image en base64                            |
| `*Tab.tsx`, `Stage.tsx`                  | Les cinq onglets : Pages, Signer et annoter, Formulaire, Texte, Finitions                  |

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
- **L'atelier PDF ne quitte pas le poste.** Ce qu'il assemble, dessine ou lit se
  fait dans le navigateur ; le serveur ne voit le document que si l'on demande
  l'allègement ou la reconnaissance de texte, et alors comme toute conversion.
- **Le document produit est toujours neuf.** Les pages sont copiées dans un PDF
  vierge (pdf-lib ne sait pas réordonner les pages d'un fichier ouvert) ; un
  fichier protégé en sort libre, et seul le mot de passe des finitions le
  referme. `copyPages` laisse le formulaire derrière : `build.ts` copie le
  dictionnaire du formulaire avec le même copieur que les pages, pour que les
  champs d'un seul fichier restent remplissables ; venus de plusieurs fichiers,
  ils sont figés, deux formulaires ne se fondant pas en un.
- **Ce qu'on pose se place dans le cadre affiché**, origine en haut à gauche de
  la page tournée comme à l'écran ; `geometry.ts` le ramène dans le repère du
  fichier comme pdf.js, rotation et origine de la boîte comprises. Un élément
  « sur toutes les pages » se reproduit à la même distance des bords les plus
  proches, pour qu'un paraphe reste dans son coin sur une page paysage.
- **Un caviardage efface pour de bon.** La page devient une image (150 points
  par pouce), rectangles noirs peints dedans : un rectangle posé par-dessus
  laisserait le texte lisible dessous. Ce qui est posé sur cette page se
  redessine par-dessus l'image, et son texte d'origine ne se copie plus.
- **La signature est visuelle.** Un tracé, un nom en police manuscrite ou une
  image posée sur la page, comme la plupart des éditeurs gratuits ; aucun
  certificat, aucune signature cryptographique.
- **Les polices que l'atelier écrit** sont celles qu'il montre : Liberation Sans
  (celle que pdf.js embarque pour les PDF sans police) pour les textes, numéros
  et filigranes, Caveat pour une signature écrite. Helvetica, sans l'Unicode,
  n'intervient que si elles manquent.
- **Une signature gardée sur le compte** l'est scellée sous le codec de l'espace
  personnel, six au plus par compte, l'image en base64 : une signature dit qui
  l'on est.

## L'exploitation

Les variables `CONVERT_*` sont décrites dans `.env.template`, leurs défauts dans
`src/server/env.ts`. Au démarrage le service sonde ses outils : une absence ne
l'empêche pas de démarrer, elle retire des formats de l'écran en nommant ce qui
manque (`convert.capabilities`). L'image se construit sans LibreOffice ni
ocrmypdf par `--build-arg WITH_DOCUMENTS=0`. Les fichiers de pdf.js (polices
standard, tables CMap, décodeurs d'images) sont servis par l'app sous
`/assets/pdfjs-<version>/`, émis au build du client par `client/vite.config.ts`.

## Tests

```bash
npm run test:features
```

depuis `DevEye/`.
