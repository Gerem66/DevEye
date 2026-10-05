# Journaux et alertes de l'instance

Où regarder quand la production va mal, et ce que chaque source sait ou ne sait
pas.

Documents voisins : [NOTIFICATIONS.md](./NOTIFICATIONS.md) (les canaux),
[MAINTENANCE.md](./MAINTENANCE.md), [STATUS_PAGE.md](./STATUS_PAGE.md).

## 1. Trois sources, trois rôles

| Source                             | Ce qu'elle contient                                                                               | Ce qu'elle ne contient pas         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Page admin **Logs** (table `logs`) | le journal d'audit : connexions, 2FA, actions admin, créations et suppressions, résultats de fond | aucune erreur technique            |
| **Sortie standard** du conteneur   | tout le technique, en JSON pino sur une ligne : requêtes, erreurs avec leur pile, plantages       | rien au-delà de la rotation Docker |
| Alertes **Système** (canaux)       | les défauts du serveur, poussés vers e-mail, Discord ou webhook (§ 3)                             | les erreurs d'utilisateurs         |

Sur la page Logs, le niveau « Sensible » marque une action à surveiller (2FA
coupée, rôle changé, terminal ouvert, maintenance), jamais une panne.

La sortie standard se lit par `docker compose logs app` (ou l'outil qui
orchestre le conteneur), ou depuis DevEye par l'agent de la machine hôte
(Appareils, action « Logs de l'appareil », source du conteneur) :
l'agent lit le niveau des lignes JSON, son filtre de niveau minimum vaut donc
pour DevEye lui-même.

## 2. Lire la sortie standard

Les refus ordinaires (introuvable, quota atteint, droit manquant, saisie
invalide) sont écrits en `info` sous `Command rejected` ou `Request rejected`,
sans le mot « error ». Ce qui reste en `error` est un défaut à corriger.

`warn` et `error` sont réservés à ce que l'instance doit corriger : un bug, sa
configuration, une de ses dépendances (MySQL, S3, SMTP, Stripe). Une panne que
le côté de l'utilisateur explique (son domaine mal relié, son jeton révoqué,
son hôte injoignable, son agent périmé, son quota atteint) part en `info` avec
le champ `cause: 'user'`, par `logFailure` du SDK. Une panne que personne
n'explique reste à l'instance : le filtre « ≥ Avertissement » du lecteur ne
montre donc que les problèmes de DevEye lui-même.

Une vague de `"cause":"user"` sur des comptes différents dans la même minute
n'est plus le fait d'un utilisateur : c'est en général la sortie réseau de
l'instance.

Le niveau « Notice » du lecteur vient de journald ou d'une ligne de texte qui
contient le mot : pino n'en écrit pas, DevEye non plus.

| Chercher              | Pour trouver                                               |
| --------------------- | ---------------------------------------------------------- |
| `"level":50`          | les erreurs : 5xx, commande qui lève, tâche de fond cassée |
| `"level":60`          | les fatales : plantage, démarrage impossible               |
| `"cause":"user"`      | les pannes du côté des utilisateurs, hors avertissements   |
| `Uncaught exception`  | une exception que rien n'a rattrapée                       |
| `Unhandled rejection` | une promesse rejetée sans `catch`                          |
| `Fatal startup error` | un démarrage qui échoue, souvent une boucle de relance     |
| `DevEye server ready` | chaque démarrage                                           |

## 3. La cible Système

Les alertes de l'instance passent par les canaux de notification, comme celles
des fonctionnalités. Elles se règlent depuis la page **Logs**, bouton
**Réglages**, onglet Notifications : réservé à un admin, dans un espace qu'il
possède. Le serveur prévient toutes les routes système des espaces dont le
propriétaire est un admin actif.

Ce qui déclenche une alerte (`src/Services/systemAlerts.ts`) :

- une erreur 5xx, sur le port privé ou sur la surface publique ;
- une commande qui lève, ou dont la réponse ne respecte pas son contrat ;
- une tâche de fond de module qui échoue ;
- un plantage du processus, avant sa sortie ;
- un arrêt propre qui n'aboutit pas ;
- chaque démarrage : un redémarrage que personne n'a demandé trahit un plantage.

**Anti-rafale** : une même clé (la route, la commande, le module) ne repart
qu'après 10 minutes, avec le compte de ses répétitions ; au-delà de 20 alertes
dans l'heure, les suivantes sont retenues et résumées en une seule. Le compteur
vit en mémoire : une boucle de plantages envoie une alerte par relance.

**Hors production** (`ENVIRONMENT` autre que `prod`), rien ne part : un serveur
de développement branché sur la base partagée préviendrait la production. Le
journal note `System alert not sent outside production`. L'envoi d'essai des
réglages, lui, part toujours.

Au démarrage, sans aucune route système, le journal avertit : `No system alert
channel`.

## 4. Ce que DevEye ne peut pas dire de lui-même

Quand le processus est tombé, rien en lui ne prévient. La **page d'état**
(`STATUS_PAGE.md`), dans son propre conteneur, le mesure de l'extérieur et
prévient par les destinations de la cible Système, qu'elle garde pour ce
moment-là. Sans elle, une sonde externe (UptimeRobot, Better Stack) sur
`/api/health` de chaque écouteur (le port de l'app, et le port public s'il est
séparé) couvre la vivacité du processus, pas la base.

## 5. Conservation

- **Table `logs`** : 365 jours (`LOG_RETENTION_DAYS`,
  `src/Services/logRetention.ts`), purgés au démarrage puis chaque jour, par
  lots.
- **Sortie standard** : la rotation Docker des fichiers compose, 5 fichiers de
  20 Mo par conteneur.
