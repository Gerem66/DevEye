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
OSINT, Finances, Uptime, Sentinelle, CloudSync et Bases de données en ont été
purgés, les candidats restants sont listés en fin de fichier.

## Les sections

`useSettingsSections` (le seul juge) compose les onglets d'une cible, dans cet
ordre :

| Onglet | Échelle | Qui l'a | Contenu |
|---|---|---|---|
| Général | feature (et élément pour Mail, Uptime, CloudSync, Bases de données) | table `GENERAL_WIRED`, ou `settings` du manifest d'un module | les réglages qui ne sont ni sources ni notifications |
| Sources | feature | registre `sources: { hint }` | jetons, destinations, clés d'API (voir `SOURCES.md`) |
| Notifications | feature + élément | registre `notifies` | canaux et sélection (voir `NOTIFICATIONS.md`) |
| Synchronisation | élément | table `SYNC_WIRED` | cadence de relève, maintenance |
| Chiffrement | élément | table `ENCRYPTION_WIRED`, ou `settings.item` du manifest d'un module | sous quelle clé (ou sous quelle forme) la donnée de l'élément vit |
| Partage | élément | `SHARE_WIRED_FEATURES` + écriture | où l'élément est visible (voir `SHARING.md`) |
| Permissions | élément | `SHARE_WIRED_FEATURES` + `workspace.roles` | ce que chaque rôle voit de la ligne |

Chaque section « à table » suit le même patron que `SourcesSection` : la table
dit qui est branché, le panneau est **autonome** (il se charge, se sauvegarde
et s'invalide tout seul), et il importe ses composants par chemins directs,
jamais par le baril `@/Components` (qui réexporte la coquille : cycle).

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
2. Sources → une entrée `sources` au registre + un cas dans `SourcesSection`.
   Général / Synchronisation / Chiffrement → une entrée dans la table du
   dispatcheur correspondant + un panneau autonome chez la feature.
3. Si la feature a des fiches d'élément rejoignables, elle déclare son segment
   de présence `l1` avec l'identifiant nu de l'élément
   (`useLiveSegment('l1', String(id))`) : c'est ce que `goToHome.ts` écrit
   pour téléporter vers la fiche, sans table ni déclaration.

## Candidats restants (dettes connues)

- **Monitoring** : la configuration de collecte est enfouie dans un menu
  déroulant d'appareil ; `TerminalSettings` à part.
- **Audience** : origines, plateforme, rétention et clé d'un site vivent dans
  `SiteDialog` (« Modifier ») ; une partie est du réglage.
