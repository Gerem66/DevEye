# Tests et débogage

Une page d'administration (menu du compte, réservée à l'administrateur du
site) pour vérifier ce serveur tel qu'il tourne, production comprise, sans rien
y laisser. Cinq sections : les parcours complets (essais de bout en bout), les
mesures, le testeur de mails, le suivi d'usage de DevEye dans Audience, et la
galerie des composants.

Le code : les commandes `debug.*` dans `src/features/debug/` ne font que
valider, déléguer et auditer ; tout vit dans `src/Services/debug/`, un
sous-dossier par section (`e2e`, `bench`, `mail`, `selfTracking`), qui ne
s'importent pas entre eux. Seul `runs.ts` est partagé : un essai à la fois sur
ce serveur, bout en bout et mesures confondus, lancé hors de la commande (qui
rend son identifiant aussitôt) et relu chaque seconde par la page. Le client
est dans `client/src/Features/Debug/`.

## 1. Les parcours complets

Un parcours ouvre des comptes jetables, les fait passer par les vrais chemins
(HTTP et socket vers ce serveur même, dispatcheur compris), puis les supprime
avec tout ce qu'ils ont créé. Le socle en déclare trois (cycle de compte,
espace partagé, double authentification), les modules les leurs
(`FeatureServer.e2e`).

### Zéro résidu, même après un plantage

C'est l'exigence qui dessine tout le reste.

| Ce qui resterait                                | Ce qui le retire                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| comptes, espaces, éléments, sessions            | `deleteUserEverywhere` (cascade), et le `defer` d'un module pour ce qu'il tient en mémoire                       |
| journaux et inscriptions en attente d'un compte | `removeTestAccount`, et le balayage (un compte supprimé par lui-même est rattrapé par son nom dans ses journaux) |
| mails                                           | jamais envoyés : la boîte des essais retient tout mail vers `e2e.deveye.invalid`                                 |
| ce qu'un module laisse ailleurs (client Stripe) | son `sweep()`, appelé au démarrage, avant et après chaque essai                                                  |
| un essai interrompu (arrêt, plantage)           | au démarrage, l'essai passe en « arrêté », puis le balayage supprime ses comptes 30 s plus tard                  |

Trois décisions à connaître :

- **Un compte d'essai se reconnaît à `users.e2e_run`**, posé une fois, à sa
  création (`openAccount`, le seul chemin qui crée un compte), d'après son
  adresse. Jamais par l'adresse ensuite : le jour où un compte pourra changer
  d'adresse, une personne ne doit pas pouvoir devenir un compte d'essai (et, par
  exemple, obtenir Pro avec une carte de test). Côté SDK : `SdkAccount.e2e`.
- **Le domaine `.invalid` est réservé** (RFC 2606) : rien n'y est jamais
  remis. La boîte des essais (`e2e/mailbox.ts`) enveloppe l'expéditeur du
  serveur et retient tout mail vers ce domaine, attendu ou non. C'est aussi ce
  qui le ferme à un inconnu : le lien d'inscription ne lui arrive jamais.
- **Plusieurs serveurs peuvent partager une base** (un serveur de développement
  sur la base d'une instance, par exemple). Chaque compte d'essai porte
  l'étiquette de son serveur (`sha256(PUBLIC_ORIGIN)`, 6 caractères) : un
  serveur ne balaie que les siens, sous le verrou des essais, plus ceux de
  n'importe quel serveur créés il y a plus d'une heure (un essai ne dure jamais
  autant).

Les plafonds de débit : un essai relancé atteindrait vite ceux de
l'inscription. Le jeton de l'essai (`e2e/gate.ts`), tiré à chaque essai et
gardé en mémoire le temps qu'il dure, les lève, mais seulement depuis ce
serveur même : l'adresse TCP réelle, qu'aucun en-tête transmis ne change.

### Ajouter un scénario

Dans un module : une entrée `e2e` de son `FeatureServer`, un scénario
(`id`, `label`, `skip?`, `steps`), des étapes qui lèvent pour échouer. Le
contexte (`SdkE2eContext`) donne un compte jetable connecté, `send` par sa
socket, `fetch` vers une route publique, `waitFor`, et `defer`, à appeler
juste après avoir créé quelque chose, avant ce qui peut échouer. Ce qui vit
dans les tables du module part avec le compte ; seul ce qui vit ailleurs
(un planificateur en mémoire, un objet chez un tiers) demande un `defer`, et un
`sweep` s'il peut survivre à un plantage. Exemples : `features/notes`,
`features/uptime`, `features/audience` ; pour un objet chez un tiers (un client
Stripe), le module de facturation des comptes déclare un `sweep`.

Dans le socle : `src/Services/debug/e2e/scenarios/`, même forme, avec
`accounts: 0 | 1 | 2` pour les comptes ouverts avant la première étape.

## 2. Les mesures

Ce que coûte chaque opération à cet instant, pour comparer d'une charge à
l'autre : base, écriture annulée, scellement, hachage de mot de passe, HTTP en
local et par l'adresse publique, poignée de main SMTP, et deux sondes
mesurées par le navigateur (commande par la socket, requête HTTP). Chaque
mesure enregistre aussi ce que faisait le serveur (retard de la boucle, CPU,
mémoire, charge, connexions) : c'est ce qui permet de lire un écart.

Sans danger en production : une sonde après l'autre, jamais en parallèle,
quelques itérations, un plafond par sonde et 30 s pour le tout. Le hachage
Argon2 occupe le pool de threads : une ou trois fois seulement.

Ajouter une sonde : une entrée de `PROBES` (`bench/probes.ts`). Elle doit être
bornée, et ne rien laisser (l'écriture se fait dans une transaction annulée).

## 3. Le testeur de mails

Tous les mails que ce serveur sait envoyer, construits par la même fonction
qu'en vrai sur des données d'exemple, envoyés à une adresse saisie depuis leur
vrai expéditeur : celui du serveur (`SMTP_*`) pour l'inscription, la
suppression du compte et les abonnements ; une boîte d'un espace dont
l'administrateur est propriétaire pour ceux qui partent d'un espace
(Rendez-vous, Facturation, alertes). Dix envois par dix minutes et par
administrateur : l'expéditeur du serveur ne doit pas devenir un canon à spam.

Un module déclare ses mails dans `FeatureServer.mailSamples`. Un échantillon
qui ne passe pas par le vrai constructeur ne prouve rien : c'est la seule
règle. Un mail du serveur rend un `SdkAccountMailMessage` (la mise en page est
celle de `accountMail.send`, `renderAccountMail`), un mail d'espace le message
du transport Mail.

## 4. Le suivi d'usage

L'usage de DevEye lui-même, dans un site Audience de l'instance : les pages
ouvertes, les actions faites (chaque commande qui écrit, depuis le
dispatcheur), les refus rencontrés (avec leur code : un quota atteint se lit
autant qu'une panne), et les routes d'authentification. Anonyme comme tout
site suivi : ni cookie, ni nom de compte, un visiteur ne se reconnaît pas d'un
jour à l'autre.

- **La clé ne quitte jamais le serveur.** Le navigateur envoie ses pages à
  `/api/tracking`, qui les dépose dans Audience par `AUDIENCE_SELF_PROVIDER`,
  sans passer par la route publique : un tiers ne peut rien écrire dans le site,
  seules les pages de l'app (par leur `Origin`) y déposent des chemins statiques.
- **Le réglage vaut pour un serveur** (`instance_settings`, rangé par
  `PUBLIC_ORIGIN`) : un serveur de dev sur la base de la prod n'écrit rien dans
  le site de la prod.
- **Qui ne compte jamais** : le trafic des essais et les comptes d'essai ; les
  administrateurs sont écartés par défaut (un interrupteur les compte).
- **Une page se nomme par un chemin statique**, jamais un identifiant : la vue
  ouverte (`/uptime`), la sous-vue qu'un module déclare par `useSubView`
  (`/audience/site/traffic`), ou la coquille de réglages
  (`/settings/uptime/notifications`). Le même chemin nourrit le rapport de bug.
- **Une même action d'une même connexion ne compte qu'une fois par 10 s** : un
  texte enregistré à la frappe n'est pas cent actions.

« Créer l'audience » déclare le site dans l'espace personnel de
l'administrateur et s'y branche ; « Utiliser un site existant » n'accepte
qu'un site d'un de ses espaces, sans quoi l'usage de DevEye irait à un tiers.

### Les pages publiques

La page d'état (`STATUS_PAGE_URL`) et le site vitrine (`SITE_URL`) ont chacun
leur site Audience à côté de celui de l'app, dans le même espace, mesuré par
la balise publique comme un site tiers : une vue par page, les clics nommés,
le plafond par adresse d'un site neuf. « Créer l'audience » les déclare avec
celui de l'app ; « Créer les sites manquants » rattrape une adresse réglée
après coup. Le réglage les garde sous `status` et `site`, et « Débrancher »
les oublie avec le reste.

- **La page d'état lit sa clé chez DevEye** (`GET /api/statuspage/tracking`,
  sous le jeton de la sonde), au même rythme que les destinations des alertes :
  rien à régler chez elle, et la pause du suivi lui retire sa balise.
- **Le site vitrine, statique, la reçoit à sa construction** : la section donne
  les deux arguments à coller (`PUBLIC_AUDIENCE_ORIGIN`, `PUBLIC_AUDIENCE_KEY`).
  Son site porte aussi le formulaire `contact` (sujet, nom, e-mail, message,
  tous requis), déclaré strict : c'est ce que sa fenêtre « Écris-moi » envoie,
  et les messages se lisent dans les retours du site, dans Audience.

## 5. La galerie

Tous les composants de l'interface, en vrai et manipulables, dans chaque mode
de rendu et désactivés. Les jetons du thème et les icônes sont lus dans les
feuilles chargées, à l'exécution : rien à tenir à jour. Un composant nouveau
s'y ajoute dans la section de sa famille (`Features/Debug/Gallery/sections/`).
