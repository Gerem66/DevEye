# La coquille de réglages : une seule, partout

## La règle

Toute configuration passe par **une seule coquille**
(`client/src/Components/FeatureSettings`) : un dialogue à navigation gauche,
ouvert par **un seul bouton** (`FeatureSettingsButton`), monté de la même
manière partout. À l'échelle d'une fonctionnalité, le bouton vit dans son
en-tête, à droite. À l'échelle d'un élément, il vit dans la rangée d'en-tête de
sa fiche, en dernière position (voir la règle des en-têtes de fiche). Le bouton
se supprime lui-même quand aucune section n'est lisible : les features ne le
conditionnent jamais elles-mêmes.

Un dialogue artisanal derrière un engrenage à part est une dette : Mail, Météo,
OSINT, Finances, Uptime, Sentinelle, CloudSync, Bases de données, Déploiement,
Git, Audience et enfin Appareils en ont été purgés. La liste des candidats est
close (voir en fin de fichier).

## Les sections

`useSettingsSections` (le seul juge) compose les onglets d'une cible, dans cet
ordre :

| Onglet          | Échelle                                         | Qui l'a                                                                      | Contenu                                                           |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Général         | feature, et élément pour toute feature à fiches | `settings` du manifest d'un module (plus aucune native n'en déclare)         | l'élément lui-même (ce que « Modifier » portait) et ses réglages  |
| Sources         | feature                                         | `settings.feature` du manifest d'un module (plus aucune native n'en déclare) | jetons, destinations, clés d'API (voir `SOURCES.md`)              |
| Domaines        | feature                                         | `settings.feature` + `domains` du manifest d'un module                       | noms de domaine servis, enregistrements DNS, vérification         |
| Notifications   | feature + élément                               | registre `notifies`                                                          | canaux et sélection (voir `NOTIFICATIONS.md`)                     |
| Synchronisation | élément                                         | `settings.item` du manifest d'un module (Mail)                               | cadence de relève, maintenance                                    |
| Chiffrement     | élément                                         | `settings.item` du manifest d'un module                                      | sous quelle clé (ou sous quelle forme) la donnée de l'élément vit |
| Projets         | élément                                         | `PROJECT_LINKED_FEATURES` + module Projets + droit `projects`                | quels projets utilisent l'élément, ici et dans les autres espaces |
| Partage         | élément                                         | `SHARE_WIRED_FEATURES` + écriture                                            | où l'élément est visible (voir `SHARING.md`)                      |
| Permissions     | élément                                         | `SHARE_WIRED_FEATURES` + `workspace.roles`                                   | ce que chaque rôle voit de la ligne                               |

Général, Sources, Synchronisation et Chiffrement viennent tous du manifest
d'un module : l'onglet est déclaré dans `settings.feature` ou `settings.item`,
le panneau vient de son entrée client (`settingsPanels`, sur
`SettingsPanelProps<Id>` : un nombre pour toute feature à lignes, un texte pour
un appareil, dont l'id est un UUID), et `ModulePanel` le monte. Un panneau est
**autonome** (il se charge, se sauvegarde et s'invalide tout seul) et respecte
`canWrite`. Les sections que la coquille rend elle-même (partage, permissions,
notifications) restent à clé numérique : une feature dont les éléments sont
des textes n'y est pas branchée, et n'en déclare pas.

Projets est une section générique de plus, à l'échelle d'un élément : elle
liste, espace par espace, les projets qui l'utilisent, et l'y attache ou l'en
retire. Le module ne fournit aucun panneau. Les liaisons appartiennent à Projets
(`PROJECTS_USAGE_PROVIDER`), mais les commandes sont natives (`links.projects*`,
`src/features/sharing/projectLinks.ts`) : un projet vit dans un espace, l'élément
est visible dans plusieurs, et le contexte d'un module ne sort jamais de l'espace
actif. Le droit qui tranche est `projects: write` dans l'espace du **projet** ;
ailleurs la liste reste lisible et ses cases sont inertes.

Domaines est une section générique elle aussi : le module ne fournit aucun
panneau. Il déclare `domains` dans son manifest (la phrase de tête, la phrase
de l'étape « relier au service », l'exemple du champ, l'avertissement du
retrait) et l'entrée `domains` de son serveur (les enregistrements à publier,
la sonde du service). La coquille rend la liste (`DomainsSection`), l'ajout par
dialogue, et le dialogue des trois étapes (`DomainRecordsDialog`) : prouver la
propriété, relier au service, vérifier, chacune avec son état vivant et ses
enregistrements copiables. Les commandes sont transversales (`domain.*`, la
fonctionnalité en argument), le sujet en direct est `domain`. Un formulaire de
module qui désigne un domaine lit `useDomains(feature)` et ouvre l'onglet par
`<FeatureSettingsButton initialSection='domains' />`.
Les tables de câblage natif (`GENERAL_WIRED`, `SYNC_WIRED`, `ENCRYPTION_WIRED`)
et leurs dispatcheurs ont disparu avec le rapatriement de Mail, leur dernier
occupant : une native n'a plus que les sections génériques (Notifications,
Partage, Permissions).

## Modifier un élément, c'est son onglet Général

Une fiche d'élément n'a pas de bouton « Modifier » à côté du bouton de
réglages : ce que le dialogue de création demande vit, une fois l'élément né,
dans l'onglet **Général** de ses réglages, en tête de la nav. Les mêmes
champs, un `SaveButton`, et en bas la suppression derrière un `ConfirmDialog`.
Le dialogue de création ne fait plus que créer. Une identité qui ne change
pas après coup (le `owner/repo` d'un dépôt) s'y montre sans se modifier, avec
la phrase qui dit pourquoi. Une porte pour changer une chose, et la même dans
toutes les features.

## Le bouton Enregistrer est au pied du dialogue

Un `SaveButton` qui enregistre **tout l'onglet** ne se pose pas en bas du
contenu : dès qu'il y a un ascenseur, il est hors de vue, et il est de toute
façon le geste le plus discret de la page alors qu'il est le seul qui compte.
La coquille lui offre le pied du dialogue, épinglé en bas à droite, hors de ce
qui défile : c'est là qu'il va par défaut (`placement='footer'`), par un
portail, sans quitter l'arbre React de son panneau. On l'écrit donc là où
l'on écrivait le bouton, sans conteneur autour : un `sectionActions` vide
laisserait son écart en bas du panneau.

Un bouton qui n'enregistre **qu'une partie** (un champ à côté de son bouton,
l'élément en cours d'une liste) reste où il est écrit, avec
`placement='inline'` : sa place dit ce qu'il concerne. Les autres gestes d'un
onglet (tester la connexion, supprimer l'élément) restent dans le panneau,
dans leur `sectionActions`.

Le pied est toujours rendu, même quand aucun panneau ne l'occupe : un pied qui
apparaît et disparaît selon l'onglet ferait changer la hauteur du dialogue à
chaque clic de la nav.

Deux sorties, dans le contrat des panneaux (`SettingsPanelProps`) :

- `close()` referme la coquille et rien d'autre, pour un geste qui se suit
  mieux sur l'écran du dessous (une resynchronisation dont la fiche dessine
  l'avancement) ;
- `gone()` dit que l'élément réglé **n'est plus ici** : supprimé, ou déplacé
  vers un autre espace. La coquille se referme, puis la fiche qui l'a ouverte
  s'en va, par le `onGone` que la fiche passe au bouton commun (le même geste
  que son bouton de retour). À appeler dès que la commande a réussi, et
  **avant** de raviver les ressources : une fiche relue avant de partir
  chercherait un élément disparu. L'onglet Partage l'appelle de lui-même après
  un déplacement, que suit un dialogue de progression que rien ne ferme
  (`ProgressDialog`) : tout l'arbre est relu et rescellé, et un écran figé ne
  dit pas si le clic a pris.

## Sans l'écriture

Un panneau reste **lisible** : les valeurs se voient, les champs sont grisés,
et le refus se dit d'une seule voix, `ReadOnlyNotice` (exporté par
`deveye-sdk-client`), à la place du bouton d'enregistrement. Un composant
plutôt qu'une classe parce que chaque panneau réinventait sa taille et sa
couleur, et que deux onglets voisins ne se ressemblaient plus. Le cadenas est
celui des motifs de droit de `PERMISSIONS.md` ; ce qui bloque pour une autre
raison (un appareil archivé, un élément qu'on ne peut pas projeter) garde sa
propre phrase, et son propre motif.

L'exception est l'onglet qui ne porte **que des gestes** : sans l'écriture il
n'a rien à montrer, et il disparaît au lieu de s'excuser dans le vide. Il se
déclare `requiresWrite: true` au manifest, la coquille le retire, et son
panneau n'a alors pas de cas en lecture seule à écrire. Un seul le fait
aujourd'hui : « Avancé » de Mail, qui reconstruit le cache d'un dossier.

## La navigation traverse les échelles et les espaces

Trois mécanismes font qu'aucun réglage n'est un mur :

1. **Élément → fonctionnalité** : depuis les réglages d'un élément, « Gérer
   les canaux » et le « + » des états vides empilent les réglages de la
   fonctionnalité par-dessus, sur le bon onglet (`initialSection`).
2. **Dialogue d'élément → sources** : le « + » d'un sélecteur de source ouvre
   les réglages de la fonctionnalité sur l'onglet Sources, et l'élément adopte
   la source créée au retour (voir `SOURCES.md`).
3. **Fenêtre → domicile** : sur un élément projeté, un réglage qui se gère
   dans l'espace d'origine propose « Régler dans <espace> » (si l'appelant en
   est membre) : bascule d'espace, ouverture de la fiche par la téléportation
   (`goToHome.ts`, mêmes segments de présence que « rejoindre quelqu'un »),
   puis réouverture des réglages sur le même onglet via l'intention de
   `stores/settingsRequest`, consommée par le bouton commun. Le consommateur
   unique est ce qui rend le saut gratuit : monter le bouton commun suffit.

## Brancher une feature de plus

1. L'en-tête de la feature (et de ses fiches d'élément) monte
   `FeatureSettingsButton`, sans condition. Une fiche lui passe `onGone`, son
   bouton de retour : l'élément supprimé ou déplacé depuis la coquille, la
   fiche s'en va.
2. Général / Sources / Synchronisation / Chiffrement → l'onglet dans le
   manifest du module (`settings.feature` ou `settings.item` ; `sync` et
   `encryption` à l'échelle d'un élément seulement) + un panneau autonome dans
   `settingsPanels`, sous le même id. Une native n'a plus d'onglet propre.
   Un onglet qui ne porte que des gestes ajoute `requiresWrite: true` ; sinon,
   le panneau rend `ReadOnlyNotice` quand `canWrite` est faux. Le Général
   d'un élément porte sa modification et sa suppression (`gone()`) ; le
   dialogue de création ne fait que créer.
3. Si la feature a des fiches d'élément rejoignables, elle déclare son segment
   de présence `l1` avec l'identifiant nu de l'élément
   (`useLiveSegment('l1', String(id))`) : c'est ce que `goToHome.ts` écrit
   pour téléporter vers la fiche, sans table ni déclaration.

## La liste des candidats est close

Plus aucune feature ne règle quoi que ce soit hors de la coquille.

Appareils, le dernier candidat, l'a quittée à son rapatriement en module
(`features/devices`). Tout s'y règle à l'échelle d'un **appareil**, sous deux
onglets déclarés dans `settings.item` et rendus par `SettingsPanel.tsx` :
`collect` (cadence, capture des processus, conservation, estimation du coût en
base ; `ConfigPanel`) et `terminal` (compte d'ouverture des sessions, sort du
terminal à la fin du shell ; `TerminalSettings`). Les deux sont portés par la
ligne de l'appareil, donc partagés avec les espaces qui le voient. La
fonctionnalité n'a plus aucun réglage commun : `settings.feature` est absent du
manifest, et le bouton d'engrenage à l'échelle de la feature disparaît de
lui-même (`FeatureSettingsButton` rend `null` sans section). Le terminal garde
un bouton « Relancer la session » à côté du bouton commun, pour appliquer un
nouveau compte sans fermer le dialogue.

Audience l'avait quittée avant : la mesure, la reconnaissance des visiteurs
et la conservation d'un site vivent dans son panneau Général
(`SiteGeneralPanel`), avec l'identité (nom, description, plateforme, origines)
depuis que le dialogue « Modifier » a disparu ; la clé publique reste dans le
dialogue d'installation, qui n'est pas un réglage mais un geste.
