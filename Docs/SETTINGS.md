# La coquille de réglages : une seule, partout

## La règle

Toute configuration passe par **une seule coquille**
(`client/src/Components/FeatureSettings`) : un dialogue à navigation gauche,
ouvert par **un seul bouton** (`FeatureSettingsButton`), monté de la même
manière partout. À l'échelle d'une fonctionnalité, le bouton vit dans son
en-tête, à droite. À l'échelle d'un élément, il vit dans la rangée d'en-tête de
sa fiche, en dernière position. Le bouton se supprime lui-même quand aucune
section n'est lisible (`useSettingsSections` rend une liste vide) : les
features ne le conditionnent jamais elles-mêmes.

Un dialogue artisanal derrière un engrenage à part n'existe pas : tout réglage
passe par la coquille, qu'il vienne d'un panneau du module ou d'une section que
la coquille rend elle-même.

## Les sections

`useSettingsSections` (`index.tsx`, le seul juge) compose les onglets d'une
cible dans cet ordre : d'abord ceux que le manifest du module déclare
(`settings.feature` ou `settings.item`), **dans l'ordre de la déclaration**,
puis ceux que la coquille ajoute d'elle-même : Notifications, Projets, Partage
(ou Copie), Permissions.

| Onglet                | Échelle            | Qui l'a                                                                                                                | Contenu                                                                                                                                                                                        |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Général               | feature ou élément | `'general'` au manifest                                                                                                | l'élément lui-même (ce qu'un « Modifier » porterait) et ses réglages                                                                                                                           |
| Sources               | feature            | `'sources'` au manifest, qui exige `sources: { hint }`                                                                 | jetons, destinations, clés d'API (voir `SOURCES.md`)                                                                                                                                           |
| Domaines              | feature            | `'domains'` au manifest, qui exige `domains` et l'entrée serveur `domains`                                             | noms de domaine servis, enregistrements DNS, vérification                                                                                                                                      |
| Synchronisation       | élément            | `'sync'` au manifest                                                                                                   | cadence de relève, maintenance d'un élément tenu à jour en fond                                                                                                                                |
| Chiffrement           | élément            | `'encryption'` au manifest                                                                                             | sous quelle clé (ou sous quelle forme) la donnée de l'élément vit                                                                                                                              |
| Onglets personnalisés | feature ou élément | `{ id, label, icon?, requiresWrite? }` au manifest (`CustomTabRef`)                                                    | ce que le module veut : Catégories de Finances, Appareils de Sentinelle, Alertes d'une base, Collecte et Terminal d'un appareil, Contenu et Avancé de Mail, Fréquentation et Retours d'un site |
| Notifications         | feature + élément  | `notifies` du descripteur ; à l'échelle d'un élément seulement avec `hasItems`, et sauf `notifications.perItem: false` | canaux et sélection (voir `NOTIFICATIONS.md`)                                                                                                                                                  |
| Projets               | élément            | `PROJECT_LINKED_FEATURES` + module Projets installé + droit `projects` dans l'espace actif                             | quels projets utilisent l'élément, ici et dans les autres espaces                                                                                                                              |
| Partage               | élément            | branchement au partage (`isShareWired`) + écriture sur l'élément                                                       | où l'élément est visible (voir `SHARING.md`)                                                                                                                                                   |
| Copie                 | élément            | les mêmes, quand l'élément ne se projette pas (`shareable: false`)                                                     | la section Partage réduite à la copie : un élément gardé par mot de passe ne se projette ni ne se déplace, mais il se copie                                                                    |
| Permissions           | élément            | branchement au partage + droit `itemPermissions` du grant (ou `workspace.roles`), dans un espace partagé               | ce que chaque rôle voit de la ligne                                                                                                                                                            |

Général, Sources, Synchronisation, Chiffrement et les onglets personnalisés
viennent du manifest : l'onglet est déclaré dans `settings.feature` ou
`settings.item`, le panneau vient de l'entrée client du module
(`settingsPanels`, sur `SettingsPanelProps` : la portée porte un `itemId` texte,
que la feature relit en nombre si sa table est à clé numérique, un appareil
étant un UUID), et `ModulePanel` le monte. Un panneau est **autonome** (il se
charge, se sauvegarde et s'invalide tout seul) et respecte `canWrite`, évalué
sur l'élément quand il y en a un : ses droits peuvent différer de ceux de la
fonctionnalité, dans les deux sens. `validateManifest` tient la grammaire :
`sources` et `domains` à l'échelle de la feature seulement, `encryption` à celle
d'un élément, `notifications` seulement avec `notifies`, un onglet d'élément
seulement avec `hasItems`.

Notifications, Projets, Partage, Copie et Permissions sont rendues par la
coquille elle-même (`sections/*`), à clé numérique : une feature dont les
éléments sont des textes n'y est pas branchée.

Projets est une section générique à l'échelle d'un élément : elle liste, espace
par espace, les projets qui l'utilisent, et l'y attache ou l'en retire. Le
module ne fournit aucun panneau. Les liaisons appartiennent à Projets
(`PROJECTS_USAGE_PROVIDER`), mais les commandes sont transversales
(`links.projectsGet`, `links.projectsSet`,
`src/features/sharing/projectLinks.ts`) : un projet vit dans un espace,
l'élément est visible dans plusieurs, et le contexte d'un module ne sort jamais
de l'espace actif. Le droit qui tranche est `projects: write` dans l'espace du
**projet** ; ailleurs la liste reste lisible et ses cases sont inertes.

Domaines est une section générique elle aussi : le module ne fournit aucun
panneau. Il déclare `domains` dans son manifest (la phrase de tête, la phrase de
l'étape « relier au service », l'exemple du champ, l'avertissement du retrait)
et l'entrée `domains` de son serveur (les enregistrements à publier, la sonde du
service). La coquille rend la liste (`DomainsSection`), l'ajout par dialogue, et
le dialogue des trois étapes (`DomainRecordsDialog`) : prouver la propriété,
relier au service, vérifier, chacune avec son état vivant et ses
enregistrements copiables. Les commandes sont transversales (`domain.*`, la
fonctionnalité en argument), le sujet en direct est `domain`. Un formulaire de
module qui désigne un domaine lit `useDomains(feature)` et ouvre l'onglet par
`<FeatureSettingsButton initialSection='domains' />`.

L'allure d'une page qu'un module sert au public (réservation, tableau de
projet) se choisit partout avec le même contrôle, `PageLookFields`
(`Components/PageLook`) : thème, accent, et la vignette de la page que le module
passe en dessous. La palette et le calcul de l'accent sont dans
`src/sdk/pageLook.ts` de `@deveye/types`, pour que la page les pose à
l'identique.

## Modifier un élément, c'est son onglet Général

Une fiche d'élément n'a pas de bouton « Modifier » à côté du bouton de
réglages : ce que le dialogue de création demande vit, une fois l'élément né,
dans l'onglet **Général** de ses réglages, en tête de la nav. Les mêmes champs,
un `SaveButton`, et en bas la suppression derrière un `ConfirmDialog`. Le
dialogue de création ne fait que créer. Une identité qui ne change pas après
coup (le `owner/repo` d'un dépôt) s'y montre sans se modifier, avec la phrase
qui dit pourquoi. Une porte pour changer une chose, et la même dans toutes les
features.

## Le bouton Enregistrer est au pied du dialogue

Un `SaveButton` qui enregistre **tout l'onglet** ne se pose pas en bas du
contenu : dès qu'il y a un ascenseur, il est hors de vue, et il est de toute
façon le geste le plus discret de la page alors qu'il est le seul qui compte.
La coquille lui offre le pied du dialogue, épinglé en bas à droite, hors de ce
qui défile : c'est là qu'il va par défaut (`placement='footer'`), par un
portail, sans quitter l'arbre React de son panneau. On l'écrit donc là où l'on
écrirait le bouton, sans conteneur autour.

Un bouton qui n'enregistre **qu'une partie** (un champ à côté de son bouton,
l'élément en cours d'une liste) reste où il est écrit, avec
`placement='inline'` : sa place dit ce qu'il concerne. Les autres gestes d'un
onglet (tester la connexion, supprimer l'élément) restent dans le panneau. Hors
de la coquille, tout est inline.

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
plutôt qu'une classe, pour que deux onglets voisins se ressemblent. Le cadenas
est celui des motifs de droit de `PERMISSIONS.md` ; ce qui bloque pour une autre
raison (un appareil archivé, un élément qu'on ne peut pas projeter) garde sa
propre phrase, et son propre motif.

L'exception est l'onglet qui ne porte **que des gestes** : sans l'écriture il
n'a rien à montrer, et il disparaît au lieu de s'excuser dans le vide. Il se
déclare `requiresWrite: true` au manifest, la coquille le retire, et son panneau
n'a alors pas de cas en lecture seule à écrire. Exemple : « Avancé » de Mail,
qui reconstruit le cache d'un dossier.

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
   (`FeatureSettings/goToHome.ts`, les segments `view:<feature>` et `l1:<id>`,
   ceux de « rejoindre quelqu'un »), puis réouverture des réglages sur le même
   onglet via l'intention de `stores/settingsRequest`, consommée par le bouton
   commun. Le consommateur unique est ce qui rend le saut gratuit : monter le
   bouton commun suffit.

## Brancher une feature de plus

1. L'en-tête de la feature (et de ses fiches d'élément) monte
   `FeatureSettingsButton`, sans condition. Une fiche lui passe `onGone`, son
   bouton de retour : l'élément supprimé ou déplacé depuis la coquille, la
   fiche s'en va. Le composant qui détient la présence (`useLiveSegment`) lui
   passe `onOpenChange`.
2. Général, Sources, Synchronisation, Chiffrement et onglets personnalisés : la
   déclaration dans le manifest (`settings.feature` ou `settings.item` ; `sync`
   et `encryption` à l'échelle d'un élément seulement) + un panneau autonome
   dans `settingsPanels`, sous le même id. Un onglet qui ne porte que des gestes
   ajoute `requiresWrite: true` ; sinon, le panneau rend `ReadOnlyNotice` quand
   `canWrite` est faux. Le Général d'un élément porte sa modification et sa
   suppression (`gone()`) ; le dialogue de création ne fait que créer.
3. Si la feature a des fiches d'élément rejoignables, elle déclare son segment
   de présence `l1` avec l'identifiant nu de l'élément
   (`useLiveSegment('l1', String(id))`) : c'est ce que `goToHome.ts` écrit pour
   téléporter vers la fiche, sans table ni déclaration.

## Deux exemples

**Appareils** règle tout à l'échelle d'un **appareil**, sous deux onglets
personnalisés déclarés dans `settings.item` et rendus par `SettingsPanel.tsx` du
module : `collect` (la collecte de l'agent, `ConfigPanel`) et `terminal`
(`TerminalSettings`). La fonctionnalité n'a aucun réglage commun :
`settings.feature` est absent du manifest, et le bouton à l'échelle de la
feature disparaît de lui-même.

**Audience** règle un site dans son panneau Général (`SiteGeneralPanel`),
identité comprise, et ajoute deux onglets personnalisés, Fréquentation
(`traffic`) et Retours (`forms`) ; la clé publique reste dans le dialogue
d'installation, qui n'est pas un réglage mais un geste.
