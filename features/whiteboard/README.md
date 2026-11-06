# Tableau blanc : dessiner à plusieurs avec Excalidraw

Des schémas à main levée, dans l'éditeur [Excalidraw](https://excalidraw.com)
(MIT), dessinés à plusieurs en même temps : chacun voit les traits et le
curseur des autres au fil du geste. Un tableau appartient à un espace, se
partage vers un autre, se copie et se déplace comme un élément de Notes. C'est
une feature de grille (carte d'accueil + panneau).

Documents voisins : [Docs/LIVE.md](../../Docs/LIVE.md) (la voie de poussée et
ses destinataires), [Docs/SHARING.md](../../Docs/SHARING.md),
[Docs/QUOTAS.md](../../Docs/QUOTAS.md),
[Docs/SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md),
[Docs/DEBUG.md](../../Docs/DEBUG.md).

## Le modèle

Un **tableau** porte un titre et une **scène** : la liste des éléments
d'Excalidraw (formes, flèches, textes, traits, images), chacun avec son
identifiant, sa `version` et son `versionNonce`. Les éléments supprimés restent
dans la scène un jour, le temps qu'un participant en retard ne les fasse pas
revenir, puis l'écriture suivante les retire.

Les **images** collées dans un tableau ne vivent pas dans la scène : un élément
image n'y porte que l'identifiant de son fichier (`fileId`), et les octets vont
au magasin d'objets. Une image qu'aucun élément ne montre plus est marquée
orpheline et retirée au bout d'un jour, ce qui laisse à une annulation le temps
de la faire revenir.

Le **fond** et le **thème** d'un tableau sont communs à tous ses
participants. Un membre qui peut écrire les choisit dans le menu d'Excalidraw ;
ils s'enregistrent aussitôt et changent en direct chez les autres. Sans choix,
le fond est celui d'Excalidraw et le thème celui du profil de chacun.

Un **aperçu** (une vignette WebP de quelques dizaines de kilo-octets) est
produit par le navigateur d'un auteur quand il quitte le tableau, et toutes les
deux minutes pendant qu'il dessine. La grille le montre renversé quand le
tableau s'affiche en sombre, comme le canevas d'Excalidraw.

## Dessiner à plusieurs

Le serveur fait autorité, sur le modèle du Jeu de la vie : il tient en mémoire
une **séance** par tableau ouvert, fusionne ce que les participants envoient et
rediffuse ce qui l'a emporté.

- Ouvrir un tableau, c'est entrer dans sa séance (`whiteboard.join`) : la scène
  telle que le serveur la tient, les participants, le droit d'écrire.
- Chaque changement local part en **poussée** (`whiteboard.push`) : les seuls
  éléments dont la version a dépassé celle que le serveur connaît, cent
  millisecondes au plus après le geste.
- La **fusion** suit la règle d'Excalidraw : la version la plus haute
  l'emporte, et à version égale le `versionNonce` le plus petit. Une poussée qui
  n'apporte rien ne change rien.
- Ce qui l'emporte repart vers tous les participants, l'auteur compris, en
  **trame numérotée**. Un numéro qui saute dit qu'une trame s'est perdue (une
  socket en retard en perd sans prévenir) : le client rentre dans la séance et
  refusionne.
- Les **curseurs** sont ceux de DevEye, avec leur cadence, leur glissement,
  leur bulle et le réglage « Curseurs des autres » : la scène leur sert de
  surface (`useLiveCursorSurface`), si bien qu'un point désigne le même dessin
  chez chacun, quel que soit son déplacement ou son zoom. Ils circulent dans le
  canal du tableau, où `whiteboard.join` assied la connexion
  (`ctx.live.joinCursors`) : un participant venu d'un autre espace y voit les
  autres.
- La **sélection** et le **laser** allumé partent en commande postée, sans
  réponse attendue, à chaque changement ; elle vaut aussi signe de vie toutes
  les huit secondes. Un participant muet vingt secondes est retiré de la
  séance. Le cadre de ce qu'un participant a sélectionné et sa traînée laser
  prennent la couleur de son compte, comme son curseur et son avatar dans
  l'en-tête du tableau.
- La scène s'écrit en base deux secondes après la dernière modification, au
  moins toutes les quinze secondes pendant qu'on dessine, au départ du dernier
  participant et à l'arrêt du serveur. L'écriture compare la version en base :
  si quelqu'un a écrit entre-temps (un autre serveur sur la même base), sa
  scène est fusionnée à celle de la séance avant de réécrire.
- Les trames ne vont qu'aux **participants**, salle par salle : un tableau
  partagé ouvert depuis un autre espace reçoit les siennes, et un membre à qui
  son rôle masque le tableau ne reçoit rien.

Un membre en lecture seule entre dans la séance, voit tout en direct et montre
son curseur ; Excalidraw s'ouvre en mode vue, et ses poussées seraient
refusées.

Les séances vivent dans le processus : deux serveurs sur la même base ne
voient chacun que leurs participants, et ne s'écrasent pas pour autant.

## Les images

Une image arrive par `whiteboard.fileAdd`, une à la fois, en data URL :

1. le base64 est décodé strictement et les premiers octets doivent dire le
   format annoncé (PNG, JPEG, WebP, GIF ou SVG, 4 Mo au plus, la limite
   d'Excalidraw) ;
2. une image déjà reçue sur ce tableau répond `created: false` ;
3. l'offre du propriétaire de l'espace d'origine du tableau est vérifiée, puis
   la modération quand le module est installé (empreinte SHA-256, exposition
   privée) ;
4. la ligne est écrite, puis l'objet scellé ; la ligne s'efface si l'objet ne
   s'écrit pas.

Les autres participants l'apprennent par une trame et la demandent
(`whiteboard.files`, quatre mégaoctets par réponse au plus, une image au
moins). Un SVG est affiché dans une balise image : aucun script ne s'y exécute.

## Aucune requête vers un tiers

Le paquet npm d'Excalidraw n'envoie aucune mesure d'audience. Ce qu'il pourrait
demander ailleurs est coupé :

- les **polices** sont servies par DevEye, sous `/assets/excalidraw-<version>/`,
  copiées du paquet au build ; le repli que le paquet prévoit vers un CDN est
  remplacé par ce même dossier (`client/vite.config.ts`, le build échoue si sa
  forme change) ;
- les **intégrations web** (vidéos, pages tierces) sont refusées
  (`validateEmbeddable={false}`), l'IA et ses dialogues ne sont pas rendus ;
- le menu principal est celui du module, sans les liens vers les réseaux
  d'Excalidraw ; le bouton « Parcourir les bibliothèques » et les liens de
  l'aide sont masqués ;
- un lien posé sur un élément s'ouvre dans un nouvel onglet, sans accès à la
  page, et seulement en `http(s)` ;
- la politique de sécurité du contenu de DevEye bloque tout le reste (une image
  distante dans un HTML collé, la publication d'une bibliothèque).

Excalidraw et ses morceaux lourds (mermaid, le sous-ensemble de polices de
l'export SVG) ne se chargent qu'à l'ouverture d'un tableau.

## Partage, copie et déplacement

`shareTier: 'open'` : un tableau se projette dans un autre espace, où ses
membres le dessinent selon leur rôle. Sa scène reste scellée sous la clé de son
espace d'origine.

- **Copier** duplique la ligne et ses images : chaque objet est recopié tel
  quel sous une nouvelle clé, le scellé ne dépendant pas du chemin. La copie
  vers une autre instance refuse un tableau qui a des images (elles sont
  restées sur leur serveur) et renvoie vers l'export `.excalidraw` puis
  l'import ; au-delà de 256 Mo d'images, la copie passe par le même chemin.
- **Déplacer** rescelle la ligne sous la clé de l'espace d'arrivée et ne touche
  à aucune image. La séance en cours se ferme d'abord, écrite : ses
  participants quittent le tableau. Le déplacement est refusé quand l'offre du
  propriétaire d'arrivée n'a plus la place.
- **Dupliquer**, dans la vue, copie le tableau dans l'espace actif.

## Taille et offre

| Ce qui est borné      | Pour toutes les offres                   |
| --------------------- | ---------------------------------------- |
| La scène d'un tableau | 8 Mio de JSON, 20 000 éléments           |
| Une image             | 4 Mo                                     |
| Une poussée           | 500 éléments, 512 Kio par élément        |
| Une séance            | 32 participants, 200 séances par serveur |

Le quota `whiteboard.storage` (octets, flux) compte les scènes, les aperçus et
les images, orphelines comprises, sur tous les espaces du propriétaire. Il se
vérifie à la création, à l'import, à la duplication, à la copie entrante et à
chaque image ; jamais à chaque trait. La séance relit l'usage à l'ouverture
puis toutes les dix minutes : au-delà de la limite, elle écarte les poussées
qui agrandissent la scène et laisse passer celles qui la réduisent. Rien n'est
jamais supprimé. La grille ne montre l'usage qu'à partir de 80 % de la limite.

## Chiffrement

Le titre, la scène (compressée avant scellement) et l'aperçu sont scellés à
l'étage ouvert de l'espace d'origine, lisibles par la séance sans session.
Le fond et le thème restent en clair : ils ne disent rien du dessin.
Les images sont scellées (conteneur `DEVB`) par une clé du module, tirée au sort
au premier démarrage et scellée par la clé du serveur (`ft_whiteboard_key`) :
elles ne dépendent d'aucun espace, si bien que copie et déplacement ne les
rechiffrent pas. Voir [SECURITY_MODEL.md](../../Docs/SECURITY_MODEL.md).

## Export

L'export des données d'un compte écrit chaque tableau en
`<titre>.excalidraw`, que l'application d'origine rouvre telle quelle, avec son
fond et son thème, images comprises quand le titulaire les garde, plus
`tableaux.json` qui les liste. L'import relit le fond et le thème d'un tel
fichier.

## Exploitation

`WHITEBOARD_STORAGE_DIR` (défaut `/data/whiteboard`) est le dossier des images
tant que le serveur les garde sur son disque ; dans un conteneur, un volume
monté (`WHITEBOARD_STORAGE_ROOT` dans les fichiers compose). Un dossier sur
aucun volume est refusé à l'envoi d'une image. Avec un stockage S3
(`STORAGE_S3_*`), les images partent sous `<préfixe>/whiteboard/`.

Un balayage quotidien retire les images orphelines depuis plus d'un jour et les
objets qu'aucune ligne ne réclame plus (un tableau ou un espace supprimé), ces
derniers au second passage seulement.

À la désinstallation, `uninstall.sql` retire les tables ; les objets restent, à
effacer à la main.

## Commandes

| Commande                   | Rôle                                                |
| -------------------------- | --------------------------------------------------- |
| `whiteboard.list`          | Les tableaux visibles et l'usage de l'offre         |
| `whiteboard.count`         | Leur nombre, pour la carte d'accueil                |
| `whiteboard.add`           | Un tableau neuf, vide ou importé d'un `.excalidraw` |
| `whiteboard.rename`        | Changer son titre                                   |
| `whiteboard.duplicate`     | Le copier dans l'espace actif, images comprises     |
| `whiteboard.remove`        | Le supprimer, depuis son espace d'origine           |
| `whiteboard.previews`      | Les aperçus de la grille                            |
| `whiteboard.setPreview`    | Enregistrer un aperçu                               |
| `whiteboard.setAppearance` | Changer le fond ou le thème, pour tous              |
| `whiteboard.fileAdd`       | Envoyer une image                                   |
| `whiteboard.files`         | Relire des images                                   |
| `whiteboard.join`          | Entrer dans la séance                               |
| `whiteboard.leave`         | La quitter                                          |
| `whiteboard.push`          | Envoyer les éléments changés                        |
| `whiteboard.presence`      | La sélection et le laser (posté, sans réponse)      |

Trames : `whiteboard.elements`, `whiteboard.presence`, `whiteboard.peers`,
`whiteboard.saved`, `whiteboard.fileAdded`, `whiteboard.appearance`,
`whiteboard.closed`.

## Tables

| Table                  | Contenu                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `ft_whiteboard_boards` | Le tableau : titre, scène et aperçu scellés, tailles, fond et thème |
| `ft_whiteboard_files`  | Ses images : clé d'objet tirée au sort, taille, orphelinat          |
| `ft_whiteboard_key`    | La racine des clés du module, scellée par le serveur                |

## Tests

Les tests node couvrent la fusion, la séance (chargement unique, numérotation,
diffusion par salle, écritures, fusion d'une version écrite ailleurs, offre
pleine), la lecture des images et des `.excalidraw`, et les briques de
synchronisation du client. La page Tests et débogage joue trois scénarios :
créer, coller une image et supprimer ; dessiner à deux, fond et thème compris ;
partager, copier et déplacer.
