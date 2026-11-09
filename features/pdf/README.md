# PDF

Fusionner, trier, faire pivoter, signer, annoter, remplir, caviarder et
protéger des PDF, sans les confier à un site inconnu : tout se fait dans le
navigateur, les fichiers ne montent pas, et rien ne coûte au serveur, donc
aucun quota. pdf.js affiche les pages, lit le texte et les champs ; pdf-lib (le
fork maintenu de Cantoo) assemble le document dans un worker ; le résultat se
télécharge depuis une adresse `blob:`. Le serveur ne garde que les signatures
du compte. Ce que le navigateur ne sait pas faire, alléger (Ghostscript) et
reconnaître le texte d'un scan (ocrmypdf), est confié au Convertisseur, qui a
les outils et les quotas.

## La carte

| Où                                       | Quoi                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/contracts/signatures.ts`            | La forme d'une signature gardée, son plafond de taille et de nombre                        |
| `src/server/handlers.ts`                 | Les trois commandes `pdf.*` du compte : lister, garder, retirer une signature              |
| `src/server/repo.ts`                     | La table `ft_pdf_signatures`                                                               |
| `src/server/accountExport.ts`            | L'export du compte                                                                         |
| `src/server/e2e.ts`                      | Le scénario « Signature gardée » de la page Tests et débogage                              |
| `src/client/Pdf.tsx`                     | L'accueil : le dépôt, les gestes, puis l'atelier                                           |
| `src/client/PdfWorkshop.tsx`             | L'atelier : en-tête, onglets, bandeau d'export, dialogues                                  |
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

- **Rien ne quitte le poste.** Ce que l'atelier assemble, dessine ou lit se fait
  dans le navigateur ; le serveur ne voit un document que si l'on demande
  l'allègement ou la reconnaissance de texte, et c'est alors le Convertisseur
  qui le reçoit (`handFileTo('convert', …)`, cible `pdf-light` ou `pdf-ocr`),
  comme toute conversion. Dans l'autre sens, un PDF déposé dans le Convertisseur
  arrive ici par `useHandedFile('pdf', …)` et ouvre l'atelier.
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
  l'on est. Les commandes sont en `scope: 'account'` : le rôle dans un espace
  partagé ne décide pas.

## L'exploitation

Aucune variable, aucun outil. Les fichiers de pdf.js (polices standard, tables
CMap, décodeurs d'images) sont servis par l'app sous `/assets/pdfjs-<version>/`,
émis au build du client par `client/vite.config.ts`. L'allègement et la
reconnaissance de texte dépendent des outils du Convertisseur (Ghostscript,
ocrmypdf), qui dit lui-même ce qui lui manque.

## Tests

```bash
npm run test:features
```

Les calculs purs (`model`, `geometry`, `text`, `fields`, `finishing`, `split`,
`zip`, `elements`) et l'assemblage (`build`, sur des PDF fabriqués par pdf-lib)
tournent sous Node ; les handlers des signatures contre le dépôt en mémoire.
