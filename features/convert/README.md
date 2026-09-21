# Convertisseur

Convertir une vidéo, un son, une image ou un document sans confier le fichier à
un site inconnu ni apprendre les arguments de `ffmpeg`. Un assistant en quatre
étapes (type, formats, options, export), des réglages aux défauts cohérents,
la taille finale annoncée avant l'export, et deux convertisseurs directs :
devises et unités.

## La carte

| Où                           | Quoi                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `src/contracts/catalogue.ts` | **Le** fichier des formats : familles, sources, cibles, réglages, recettes    |
| `src/contracts/options.ts`   | La forme d'un réglage (`slider`, `segments`, `toggle`, `size`, `crop`…)       |
| `src/contracts/estimate.ts`  | La taille avant export, et l'arithmétique de la taille cible                  |
| `src/contracts/units.ts`     | Les unités physiques et la parité de deux devises, calcul pur                 |
| `src/server/routes.ts`       | La montée du fichier en flux et la descente du résultat, à ticket             |
| `src/server/service.ts`      | La file (un travail à la fois), l'avancement, l'entretien, les taux de change |
| `src/server/spawn.ts`        | Le lanceur d'outils : budget, veille d'arrêt, plafond de sortie               |
| `src/server/engines/`        | Un moteur par outil : ffmpeg, ImageMagick, LibreOffice et les outils PDF      |
| `src/server/storage.ts`      | Le disque : chemins, place libre, balayage                                    |
| `policy/policy.xml`          | La politique ImageMagick, copiée dans l'image par le Dockerfile               |
| `src/client/`                | L'assistant, la file des travaux, devises, unités, réglages                   |

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
awaiting_upload → uploading → queued → running → done → expired
                      ↓          ↓         ↓
                    error      canceled   error
```

`convert.create` ouvre le travail et rend une adresse de montée à ticket. Le
fichier monte en `POST` brut (`postStream` du SDK), est relu par l'outil de sa
famille, puis part en file. Le résultat se télécharge par une seconde adresse à
ticket, et quitte le disque à l'échéance. L'original part dès la conversion finie.

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
- **Trois bornes de taille, de la plus large à la plus étroite** : le mur du
  serveur (`CONVERT_MAX_FILE_BYTES`), l'offre du propriétaire de l'espace
  (quota `convert.fileBytes`, voir `Docs/QUOTAS.md`), et la place libre.
- **`policy.xml` : ni apostrophe ni guillemet dans un commentaire.** Le lecteur
  XML d'ImageMagick les prend pour un début de chaîne et avale en silence les
  règles qui suivent. `policy.test.ts` le garde ; après une retouche, relire le
  résultat avec `magick -list policy`.

## L'exploitation

Les variables `CONVERT_*` sont décrites dans `.env.template`. Au démarrage le
service sonde ses outils : une absence ne l'empêche pas de démarrer, elle retire
des formats de l'écran en nommant ce qui manque (`convert.capabilities`). L'image
se construit sans LibreOffice par `--build-arg WITH_DOCUMENTS=0`.
