# Les sources : des réglages d'espace réutilisables, désignés par les éléments

## Le problème que ça résout

Un jeton Dokploy sert dix cibles, une destination d'archives sert cinq travaux,
un jeton GitHub sert tous les dépôts : ces réglages appartiennent à l'espace,
et les éléments les désignent. Une porte par feature pour les gérer ne se
déduirait pas des autres ; il n'y en a qu'une, la même partout.

## Le contrat, en trois temps

1. **Réglages → Sources, à l'échelle de la fonctionnalité** : le seul endroit où
   une source se crée, se corrige, se retire. Corriger une source corrige d'un
   coup tout ce qui s'en sert : c'est la raison d'être de la centralisation, et
   ce qu'un champ dupliqué dans chaque élément ne saurait pas faire.
2. **Le dialogue d'un élément ne fait que choisir** : un sélecteur sur la liste
   de l'espace, jamais un formulaire de source.
3. **Le « + » à côté du sélecteur** ouvre les réglages de la fonctionnalité
   par-dessus, directement sur l'onglet Sources (`initialSection`), et
   l'élément **adopte** la source créée au retour, même principe que les
   dialogues de liaison des Projets, qui relient ce qu'ils viennent de créer.

Les canaux de notification sont des sources à part entière et suivent le
contrat à la lettre : **chaque émetteur a les siens**, déclarés et gérés dans
ses réglages à l'échelle de la fonctionnalité, et **chaque élément coche les
siens** dans les siens ; à l'échelle de la feature on liste, on ne sélectionne
pas, une sélection n'y viserait aucun élément nommable. Ils vivent dans
l'onglet **Notifications** plutôt que Sources parce que liste et cases
partagent le même écran (`Docs/NOTIFICATIONS.md`). Et une source peut en
appeler une autre : le « + » du compte expéditeur, dans le formulaire d'un canal
e-mail, ouvre le vrai dialogue de la feature Mail et adopte la boîte créée.

## Ce qui est branché

| Feature         | Sources                                                                                  | Table                                                   | Sélecteur côté élément                                                                              |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Déploiements    | accès Dokploy (adresse + clé d'API, par le serveur ou par un appareil) ou GitHub (jeton) | `ft_deploy_credentials` (le module `features/deploy`)   | `TargetDialog` à la déclaration, puis l'onglet Général de la cible                                  |
| Git             | jetons GitHub                                                                            | `ft_git_credentials` (le module `features/git`)         | `RepoPicker` / `RepoDialog` à l'ajout, puis l'onglet Général du dépôt                               |
| Sauvegardes     | destinations d'archives                                                                  | `backup_destinations`                                   | `JobDialog` à la création, puis l'onglet Général du travail                                         |
| chaque émetteur | ses canaux d'alerte                                                                      | `notification_channels` (colonne `feature`)             | section Notifications (cases)                                                                       |
| Météo           | clés d'API des fournisseurs                                                              | `weather_provider_keys`                                 | le sélecteur en bas de la fiche d'une ville, offert dès que l'espace a plus d'une source utilisable |
| Veille CVE      | clé d'API du NVD                                                                         | `feature_kv` (clé `nvdApiKey`)                          | aucun : les lectures la résolvent seules                                                            |
| Finances        | connexions bancaires                                                                     | `ft_finance_connections` (le module `features/finance`) | l'onglet Banque d'un compte du livre                                                                |
| Rendez-vous     | agendas externes                                                                         | le module                                               | chaque type de rendez-vous choisit les siens                                                        |
| Audit           | jetons présentés à la forge                                                              | le module                                               | une cible en désigne un                                                                             |

Les **domaines** suivent le même contrat (déclarés à l'échelle de la
fonctionnalité, désignés par les éléments, « + » qui ouvre le bon onglet), mais
n'ont ni table ni panneau par module : la coquille les rend elle-même pour toute
fonctionnalité qui déclare `domains` (voir `SETTINGS.md` et `FEATURE_SDK.md`).
Rendez-vous, Serveur mail, Uptime, Projets, Facturation et Hébergement s'en
servent.

## La mécanique

**Côté serveur** : des commandes du module (`deploy.credential*`,
`git.credential*`, `backup.destination*`), à l'échelle de l'espace, sous le
droit d'écriture de la feature, avec un compte d'usages (`useCount`,
`jobCount`) qui protège la suppression et dit ce qu'un retrait va couper.

**Côté client**, trois pièces :

- Le manifest (ou le descripteur du registre qu'il étale) déclare
  `sources: { hint }` et `settings.feature: ['sources']`. C'est la déclaration
  de vérité, jamais une liste locale de plus ; `validateManifest` refuse
  l'onglet sans la phrase, et la coquille rend cette phrase en tête du panneau
  (`ModulePanel`). `label` et `icon` renomment l'onglet quand « Sources » dirait
  mal ce qu'il range : Sauvegardes l'appelle « Destinations », ses sources à
  elle étant ce qu'elle sauvegarde. L'identifiant reste `sources`.
- La coquille monte le panneau de la feature (`ModulePanel` dans
  `Components/FeatureSettings/index.tsx`). Un panneau est **autonome** : il se
  charge (`useResource` sur la ressource de la feature), s'invalide et se
  rafraîchit tout seul ; la coquille ne lui passe que la portée et le droit
  d'écriture. Chaque feature à sources fournit le sien
  (`settingsPanels.sources` : `features/backup/src/client/DestinationsPanel`,
  `features/deploy/src/client/CredentialsPanel` pour les accès Dokploy et
  GitHub, `features/git/src/client/CredentialsPanel` pour les jetons GitHub).
  Tous partagent la même silhouette que la liste des canaux de la section
  Notifications : rangée (icône, libellé, méta, badge d'usage, actions en
  icônes), ajout et correction par un dialogue empilé, retrait par la
  confirmation commune (`ConfirmDialog`) qui nomme ce qui va être coupé.
- Dans le dialogue d'élément : le sélecteur sous `.fieldWithAction`
  (`settingsStyles` du barrel), le bouton commun (`FeatureSettingsButton`,
  `initialSection='sources'`) qui ouvre les réglages par-dessus, et
  l'adoption : l'ensemble des identifiants connus est photographié à
  l'ouverture des réglages (`onOpenChange`), l'identifiant apparu ensuite est
  sélectionné. L'arrivée de la liste fraîche passe par l'invalidation ordinaire
  des ressources du module : aucune voie de retour spéciale entre les deux
  dialogues.

**Le piège du baril** : `@/Components/index.ts` réexporte la coquille de
réglages. Les sections que la coquille rend elle-même (`sections/*`) importent
donc leurs composants par **chemins directs** (`@/Components/Button`), jamais
par le baril, sinon cycle de modules. Un module, lui, passe par
`deveye-sdk-client` et n'importe jamais `@/…`.

## Brancher une feature de plus

1. `sources: { hint }` et `settings: { feature: ['sources'] }` dans son
   manifest ;
2. un panneau autonome, déclaré dans `settingsPanels.sources` de son entrée
   client (sur `settingsStyles`, modèle
   `features/git/src/client/CredentialsPanel`) ;
3. dans son dialogue d'élément : sélecteur + « + » (`FeatureSettingsButton`,
   `initialSection='sources'`, `onOpenChange`) + adoption (copier l'un des
   trois existants).
