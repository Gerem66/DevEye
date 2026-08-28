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

| Onglet | Échelle | Qui l'a | Contenu |
|---|---|---|---|
| Général | feature (et élément pour Mail, Uptime, CloudSync, Bases de données, Audience, Appareils) | `settings` du manifest d'un module (plus aucune native n'en déclare) | les réglages qui ne sont ni sources ni notifications |
| Sources | feature | `settings.feature` du manifest d'un module (plus aucune native n'en déclare) | jetons, destinations, clés d'API (voir `SOURCES.md`) |
| Notifications | feature + élément | registre `notifies` | canaux et sélection (voir `NOTIFICATIONS.md`) |
| Synchronisation | élément | `settings.item` du manifest d'un module (Mail) | cadence de relève, maintenance |
| Chiffrement | élément | `settings.item` du manifest d'un module | sous quelle clé (ou sous quelle forme) la donnée de l'élément vit |
| Partage | élément | `SHARE_WIRED_FEATURES` + écriture | où l'élément est visible (voir `SHARING.md`) |
| Permissions | élément | `SHARE_WIRED_FEATURES` + `workspace.roles` | ce que chaque rôle voit de la ligne |

Général, Sources, Synchronisation et Chiffrement viennent tous du manifest
d'un module : l'onglet est déclaré dans `settings.feature` ou `settings.item`,
le panneau vient de son entrée client (`settingsPanels`, sur
`SettingsPanelProps<Id>` : un nombre pour toute feature à lignes, un texte pour
un appareil, dont l'id est un UUID), et `ModulePanel` le monte. Un panneau est
**autonome** (il se charge, se sauvegarde et s'invalide tout seul) et respecte
`canWrite`. Les sections que la coquille rend elle-même (partage, permissions,
notifications) restent à clé numérique : une feature dont les éléments sont
des textes n'y est pas branchée, et n'en déclare pas.
Les tables de câblage natif (`GENERAL_WIRED`, `SYNC_WIRED`, `ENCRYPTION_WIRED`)
et leurs dispatcheurs ont disparu avec le rapatriement de Mail, leur dernier
occupant : une native n'a plus que les sections génériques (Notifications,
Partage, Permissions).

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
   `FeatureSettingsButton`, sans condition.
2. Général / Sources / Synchronisation / Chiffrement → l'onglet dans le
   manifest du module (`settings.feature` ou `settings.item` ; `sync` et
   `encryption` à l'échelle d'un élément seulement) + un panneau autonome dans
   `settingsPanels`, sous le même id. Une native n'a plus d'onglet propre.
3. Si la feature a des fiches d'élément rejoignables, elle déclare son segment
   de présence `l1` avec l'identifiant nu de l'élément
   (`useLiveSegment('l1', String(id))`) : c'est ce que `goToHome.ts` écrit
   pour téléporter vers la fiche, sans table ni déclaration.

## La liste des candidats est close

Plus aucune feature ne règle quoi que ce soit hors de la coquille.

Appareils, le dernier candidat, l'a quittée à son rapatriement en module
(`features/devices`) : la configuration de collecte d'un appareil (cadence,
capture des processus, conservation, estimation du coût en base), autrefois
un dialogue maison enfoui dans le menu « Fonctions » du panneau
(`ConfigDialog`), est le panneau `general` d'un **appareil** (`ConfigPanel`,
typé `SettingsPanelProps<string>`), ouvert par le bouton commun en dernière
position de l'en-tête de la fiche ; les préférences du terminal distant
(`TerminalSettings`, locales au navigateur), autrefois derrière l'engrenage
du terminal, sont le panneau `general` de la **feature**. Un seul composant
(`SettingsPanel.tsx`) rend l'un ou l'autre selon `scope.kind`. Le terminal
garde un bouton « Relancer la session » à côté du bouton commun, pour
appliquer un nouveau compte sans fermer le dialogue.

Audience l'avait quittée avant : la mesure, la reconnaissance des visiteurs
et la conservation d'un site vivent dans son panneau Général
(`SiteGeneralPanel`), le dialogue « Modifier » ne garde que l'identité (nom,
description, plateforme, origines), et la clé publique reste dans le dialogue
d'installation, qui n'est pas un réglage mais un geste.
