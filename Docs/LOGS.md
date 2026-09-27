# Journaux et alertes de l'instance

Où regarder quand la production va mal, et ce que chaque source sait ou ne sait
pas.

Documents voisins : [NOTIFICATIONS.md](./NOTIFICATIONS.md) (les canaux),
[MAINTENANCE.md](./MAINTENANCE.md), [deploy/README.md](../../deploy/README.md).

## 1. Trois sources, trois rôles

| Source                             | Ce qu'elle contient                                                                               | Ce qu'elle ne contient pas         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Page admin **Logs** (table `logs`) | le journal d'audit : connexions, 2FA, actions admin, créations et suppressions, résultats de fond | aucune erreur technique            |
| **Sortie standard** du conteneur   | tout le technique, en JSON pino sur une ligne : requêtes, erreurs avec leur pile, plantages       | rien au-delà de la rotation Docker |
| Alertes **Système** (canaux)       | les défauts du serveur, poussés vers e-mail, Discord ou webhook (§ 3)                             | les erreurs d'utilisateurs         |

La sortie standard se lit dans Dokploy, ou depuis DevEye par l'agent de la
machine hôte (Appareils, action « Logs de l'appareil », source du conteneur) :
l'agent lit le niveau des lignes JSON, son filtre de niveau minimum vaut donc
pour DevEye lui-même.

## 2. Lire la sortie standard

Les refus ordinaires (introuvable, quota atteint, droit manquant, saisie
invalide) sont écrits en `info` sous `Command rejected` ou `Request rejected`,
sans le mot « error ». Ce qui reste en `error` est un défaut à corriger.

| Chercher              | Pour trouver                                               |
| --------------------- | ---------------------------------------------------------- |
| `"level":50`          | les erreurs : 5xx, commande qui lève, tâche de fond cassée |
| `"level":60`          | les fatales : plantage, démarrage impossible               |
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

Quand le processus est tombé, rien en lui ne prévient. Une **sonde externe**
(UptimeRobot, Better Stack, healthchecks.io) sur `/api/health` des deux domaines
couvre ce cas. `/api/health` ne répond que de la vivacité du processus, pas de
la base.

## 5. Conservation

- **Table `logs`** : 365 jours (`LOG_RETENTION_DAYS`), purgés au démarrage puis
  chaque jour, par lots. C'est la durée que promet la politique de
  confidentialité pour les journaux de connexion et d'accès.
- **Sortie standard** : la rotation Docker des fichiers compose, 5 fichiers de
  20 Mo par conteneur.
