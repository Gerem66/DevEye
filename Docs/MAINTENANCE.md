# Accès et maintenance

Fermer le site entier, ou une seule fonctionnalité, pour tout le monde et à
l'instant : une faille, un bug, un emballement. Ou réserver une fonctionnalité
aux administrateurs, le temps de l'essayer en production avant de l'ouvrir.
Depuis l'interface (menu du profil, « Accès et maintenance », réservé aux
administrateurs), depuis la base quand l'interface ne répond plus, ou dès le
démarrage par une variable d'environnement.

La même page tient l'accès au service : ouvrir ou fermer les inscriptions, et
donner la priorité aux abonnés quand l'afflux dépasse le serveur.

## L'accès

- **Inscriptions** : fermées par défaut. Le réglage se range par origine
  publique (`instance_settings`, nom `signups`), comme tout réglage d'un
  serveur qui peut partager sa base avec un autre : chacun ouvre les siennes.
  Une base sans aucun compte laisse toujours entrer le premier, qui naît
  administrateur. Relu à chaque étape de l'inscription.
- **Priorité aux abonnés** : les comptes dont l'offre n'a pas `priority`
  (Gratuite, l'essai sans carte, Restreinte) restent connectés, mais toute
  limite leur vaut 0. Tout ce qu'ils font tourner se met donc en pause par le
  mécanisme des offres (`Docs/QUOTAS.md`), leurs créations sont refusées, et
  tout reprend seul à la levée. Commune à tous les serveurs qui partagent la
  base, parce que les pauses le sont aussi. Sans module qui tient les offres,
  elle n'est pas proposée. Comme pour Restreinte, les espaces partagés d'un
  compte tenu se ferment à leurs membres, et ses pages publiques et ses
  domaines se mettent en pause.

## Les niveaux

| Niveau                   | Qui entre           | Ce qui est refusé                                                             | Ce qui continue                                        |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| Site en maintenance      | les administrateurs | la connexion, la socket et toute commande des autres comptes, l'inscription   | le travail de fond, les agents                         |
| Feature en préversion    | les administrateurs | ses commandes, aux autres comptes                                             | son service de fond, ses routes publiques              |
| Feature en maintenance   | les administrateurs | ses commandes et ses routes publiques (pages Rdv, traceur Audience, webhooks) | son service de fond                                    |
| Feature en arrêt complet | personne            | idem, et même les administrateurs                                             | rien : son service est arrêté, ses hooks agent ignorés |
| Priorité aux abonnés     | tout le monde       | aux comptes sans priorité : toute création, tout ce qui tourne pour eux       | les abonnés, entiers                                   |

La préversion laisse ses routes publiques ouvertes : seuls les administrateurs y
créent quelque chose, et ce qu'elles servent est à eux (le défi ACME du serveur
mail, une page de statut). Ce qu'un autre compte y avait créé avant la bascule
continue aussi d'être servi, et son travail de fond de tourner.

L'arrêt complet refuse aussi l'administrateur parce que la feature ne sait plus
répondre : ses commandes lèveraient une erreur interne. Ses `providers` restent
servis, ce sont des lectures appelées par d'autres : les quotas de la
facturation ne sautent jamais à cause d'une maintenance.

## Ce que voient les gens

- **Site** : tout compte non administrateur est déconnecté sur-le-champ et voit
  une page façon login, avec le message choisi (un texte par défaut sinon). Un
  lien « Accès administrateur » ouvre le formulaire de connexion. La page relit
  l'état toutes les 30 s et la session reprend seule à la levée.
- **Feature** : qui s'y trouve en est éjecté avec une fenêtre qui le dit ; sa
  tuile se grise avec « En maintenance » comme une tuile sans droit. Chez
  l'administrateur, la tuile reste vivante avec une pastille « Maintenance », ou
  se grise avec « Arrêt complet ».
- **Feature en préversion** : pour les autres comptes, elle n'existe pas. Sa
  tuile disparaît de l'accueil et des dossiers, et en mode organisation elle
  n'est qu'un emplacement « Indisponible », comme un module retiré. Elle quitte
  aussi le catalogue d'ajout, l'« À propos », le menu du compte, l'éditeur de
  rôles (ses droits restent enregistrés), le tableau des offres et les liens des
  autres modules (`moduleClientProvider` la tient pour absente). La présence ne
  dit pas qu'un administrateur s'y trouve. Chez l'administrateur, la tuile porte
  une pastille « Préversion ».
- **Priorité aux abonnés** : un compte tenu voit à l'accueil un bandeau qui le
  dit, avec « Voir les offres » ; ses éléments portent « Priorité aux
  abonnés », et un refus de création le dit aussi. Il peut s'abonner sans
  attendre : tout repart pour lui aussitôt.
- **Administrateur** : un bandeau à l'accueil tant que le site est en
  maintenance, ou la priorité donnée.

## Sans l'interface

### La base

Le serveur la relit toutes les 15 s : un changement s'applique sans redémarrage.

```sql
UPDATE site_maintenance SET active = 1;
UPDATE site_maintenance SET active = 0;
INSERT INTO feature_maintenance (feature, level) VALUES ('rdv', 'requests');
UPDATE feature_maintenance SET level = 'full' WHERE feature = 'rdv';
INSERT INTO feature_maintenance (feature, level) VALUES ('mailserver', 'preview');
DELETE FROM feature_maintenance WHERE feature = 'rdv';
UPDATE site_maintenance SET priority = 1;
INSERT INTO instance_settings (name, origin, value) VALUES ('signups', 'https://app.deveye.fr', 'open')
    ON DUPLICATE KEY UPDATE value = VALUES(value);
```

`site_maintenance.message` à `NULL` vaut le texte par défaut.

### `MAINTENANCE=1`

Pour un site qu'on ne peut plus atteindre, même en administrateur : poser la
variable et redémarrer. Le site est fermé avant la première connexion. Ce n'est
qu'un point de départ : la maintenance se lève ensuite depuis l'interface.

Tant que le processus tourne avec la variable et que la maintenance est levée,
un bandeau le rappelle aux administrateurs : le prochain redémarrage refermerait
le site. Sa croix le ferme pour tous les administrateurs (lu au chargement, pas
en direct). Chaque démarrage sous la variable le réarme.

## Où c'est gardé

- `src/Services/maintenance.ts` : l'état, lu de façon synchrone par les gardes ;
  chaque changement (interface, relecture) passe par `apply`, qui diffuse
  `maintenance.state` à toutes les sockets, ferme en `4503` celles des
  non-administrateurs quand le site se ferme, relance la passe des pauses quand
  la priorité change, puis arrête ou relance les services. Les changements
  s'appliquent l'un après l'autre.
- `src/Services/quota.ts` : `isHeld` et `limitIn`, par où la priorité agit.
- `src/Services/signup/setting.ts` : le réglage des inscriptions.
- `src/ws/handler.ts` : la poignée de main, la trame `session` (qui porte l'état
  initial), et `assertFeature` / `assertDeclaredFeature`, le passage obligé de
  toute commande vers une feature, qu'elle la déclare ou la reçoive en entrée.
- `src/auth/` : `/login` avant la 2FA, `/refresh` avant la rotation du jeton
  (sinon le compte perdrait sa session à la levée), `loadUserBundle`, `/ws-ticket`.
- `src/features/_sdk/register.ts` : les routes publiques des modules. Celles en
  `exposure: 'app'` passent, sauf à l'arrêt complet : elles prolongent une
  commande déjà gardée.
- `client/src/stores/maintenance.ts` : `isFeatureHidden` et `useHiddenFeatures`,
  ce qu'une préversion retire de l'écran d'un compte non administrateur.

Restent ouverts : `/api/health`, `/api/status`, `/api/maintenance`, le client,
et les agents, qui ne sont pas des utilisateurs.

## Arrêter un service

L'arrêt complet appelle `stop()` puis, à la sortie, `start()` sur le même objet
(contrat de `FeatureService`). Un service doit donc :

- rendre la main de `stop()` quand son travail en cours est fini ou interrompu,
  pas seulement quand ses minuteurs sont coupés (`createTicker` attend son tour
  en cours) ;
- ne rien laisser derrière lui qui empêcherait un second `start()` (serveur
  fermé gardé, abonnement oublié, résultat mémorisé une fois pour toutes).

Conséquences connues : arrêter CloudSync fait échouer les sauvegardes de ses
partages jusqu'à la relance ; les webhooks Stripe refusés pendant une
maintenance de la facturation sont rejoués par Stripe.
