# Les sources : des réglages d'espace réutilisables, désignés par les éléments

## Le problème que ça résout

Un jeton Dokploy sert dix cibles, une destination d'archives sert cinq travaux,
un jeton GitHub sert tous les dépôts. Ces choses-là ont toujours été rangées à
l'échelle de l'espace (`workspace_credentials`, `backup_destinations`,
`notification_channels`), mais chacune se gérait derrière **son propre
bouton** : « Accès Dokploy », « Jetons GitHub », « Destinations », plus l'ajout
de canaux offert jusque dans les réglages d'un élément. Trois features, cinq
portes, et aucun endroit qui se déduise des autres.

## Le contrat, en trois temps

1. **Réglages → Sources, à l'échelle de la fonctionnalité** : le seul endroit
   où une source se crée, se corrige, se retire. Corriger une source corrige
   d'un coup tout ce qui s'en sert : c'est la raison d'être de la
   centralisation, et ce que « dupliquer le champ dans chaque élément » avait
   de toxique.
2. **Le dialogue d'un élément ne fait que choisir** : un sélecteur sur la liste
   de l'espace, jamais un formulaire de source.
3. **Le « + » à côté du sélecteur** ouvre les réglages de la fonctionnalité
   par-dessus, directement sur l'onglet Sources (`initialSection`), et
   l'élément **adopte** la source créée au retour, même principe que les
   dialogues de liaison des Projets, qui relient ce qu'ils viennent de créer.

Les canaux de notification sont des sources à part entière et suivent le
contrat à la lettre : **chaque émetteur a les siens** (091), déclarés et gérés
dans ses réglages à l'échelle de la fonctionnalité, et **chaque élément coche
les siens** dans les siens (092) ; à l'échelle de la feature on liste, on ne
sélectionne pas, une sélection n'y viserait aucun élément nommable. Ils vivent
dans l'onglet **Notifications** plutôt que Sources parce que liste et cases
partagent le même écran (`Docs/NOTIFICATIONS.md` §2, §6, §9). Et une source
peut en appeler une autre : le « + » du compte expéditeur, dans le formulaire
d'un canal e-mail, ouvre le vrai dialogue de la feature Mail et adopte la
boîte créée.

## Ce qui est branché

| Feature | Sources | Table | Sélecteur côté élément |
|---|---|---|---|
| Déploiements | accès Dokploy (adresse + clé d'API) | `workspace_credentials` | `TargetDialog`, champ « Instance Dokploy » |
| Git | jetons GitHub | `workspace_credentials` | `RepoPicker` / `RepoDialog`, champ « Jeton d'accès » |
| Sauvegardes | destinations d'archives | `backup_destinations` | `JobDialog`, champ « Où l'écrire » |
| chaque émetteur | ses canaux d'alerte | `notification_channels` (colonne `feature`) | section Notifications (cases) |

Candidat connu, non branché : **Météo**, dont la clé d'API se saisit encore par
lieu ; la ranger en source d'espace suivrait exactement ce patron.

## La mécanique

**Côté serveur, rien de neuf** : les commandes existaient (`deploy.credential*`,
`git.credential*`, `backup.destination*`), workspace-scopées, avec le droit
d'écriture de la feature et un compte d'usages (`useCount`, `jobCount`) qui
protège la suppression et dit ce qu'un retrait va couper. Ce chantier est une
affaire de **surface** : une seule porte au lieu de cinq.

**Côté client**, trois pièces :

- `sources?: { hint }` dans `FEATURE_REGISTRY` (deveye-types) crée l'onglet et
  sa phrase de tête. C'est la déclaration de vérité : le registre, jamais une
  liste locale de plus.
- `Components/FeatureSettings/sections/SourcesSection.tsx` aiguille vers le
  panneau de la feature. Un panneau est **autonome** : il se charge
  (`useResourceVersion` sur la ressource de la feature), s'invalide et se
  rafraîchit tout seul ; la coquille ne lui passe rien. Il vit chez sa feature
  (`Features/Backup/DestinationsSection`) ou dans la coquille quand deux
  features le partagent (`sections/CredentialsPanel`, un `CredentialsKind` par
  porte). Tous partagent la même silhouette que la liste des canaux de la
  section Notifications : rangée (icône, libellé, méta, badge d'usage, actions
  en icônes), ajout et correction par un dialogue empilé, retrait par la
  confirmation commune (`ConfirmDialog`) qui nomme ce qui va être coupé.
- Dans le dialogue d'élément : le sélecteur sous `.fieldWithAction`, le « + »
  qui ouvre `FeatureSettingsDialog` avec `initialSection='sources'`, et
  l'adoption : l'ensemble des identifiants connus est photographié à
  l'ouverture des réglages, l'identifiant apparu ensuite est sélectionné.
  L'arrivée de la liste fraîche passe par l'invalidation ordinaire
  (`deploy.list`, `git.list`, `backup.destinationList`) : aucune voie de retour
  spéciale entre les deux dialogues.

**Le piège du baril** : `@/Components/index.ts` réexporte la coquille de
réglages. Tout module monté par elle (panneau de sources, dialogue qu'il ouvre)
doit donc importer ses composants par **chemins directs**
(`@/Components/Button`), jamais par le baril, sinon cycle de modules. Les
sections existantes suivent déjà cette règle.

## Brancher une feature de plus

1. `sources: { hint }` sur son entrée de `FEATURE_REGISTRY` ;
2. un panneau autonome, et son cas dans l'aiguillage de `SourcesSection` ;
3. dans son dialogue d'élément : sélecteur + « + » + adoption (copier l'un des
   trois existants) ;
4. retirer la porte dédiée qu'elle avait, s'il y en avait une ; le point du
   chantier est qu'il n'en reste qu'une.

À terme (`Docs/FEATURE_MODULES.md`), l'aiguillage de l'étape 2 a vocation à
devenir une inscription au registre comme le reste.
