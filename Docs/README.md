# Les docs de DevEye

Chaque document dit **pourquoi** les choses sont ainsi ; le code dit comment.
Ce dossier porte le transverse ; la doc d'une feature vit dans son module,
à côté de son manifest (`features/<id>/README.md`).

## Guides

| Doc                                              | Quoi                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| [CREATING_A_FEATURE.md](./CREATING_A_FEATURE.md) | la checklist d'une nouvelle feature, fichier par fichier |
| [FEATURE_SDK.md](./FEATURE_SDK.md)               | le SDK des modules de features, côté mainteneur          |
| [FEATURE_MODULES.md](./FEATURE_MODULES.md)       | la cible d'hier, atteinte : la trace du raisonnement     |

## Systèmes transverses

| Doc                                      | Quoi                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| [WORKSPACES.md](./WORKSPACES.md)         | les espaces (isolation, rôles, clés), à lire avant de toucher à l'un des trois  |
| [SECURITY_MODEL.md](./SECURITY_MODEL.md) | le chiffrement : étages ouvert/gardé, DEK, mot de passe                         |
| [KEY_ROTATION.md](./KEY_ROTATION.md)     | changer la clé serveur (`CRYPT_KEY_A/B`) : ce qu'elle emballe, la procédure     |
| [AUTH_PROMPTS.md](./AUTH_PROMPTS.md)     | le prompt de déverrouillage unique, et qui le réutilise                         |
| [PERMISSIONS.md](./PERMISSIONS.md)       | les quatre étages de droits, et les décisions actées                            |
| [SHARING.md](./SHARING.md)               | la projection d'éléments entre espaces                                          |
| [FEDERATION.md](./FEDERATION.md)         | les instances distantes : une seconde session depuis le navigateur              |
| [LIVE.md](./LIVE.md)                     | la présence en direct : roster, curseurs, invalidation poussée, téléportation   |
| [SETTINGS.md](./SETTINGS.md)             | la coquille de réglages unique, son bouton commun, ses onglets                  |
| [QUOTAS.md](./QUOTAS.md)                 | offres et quotas, l'entrée de compte d'un module, illimité sans fournisseur     |
| [ACCOUNT_EXPORT.md](./ACCOUNT_EXPORT.md) | l'export des données d'un compte : l'archive, le sort de chaque table           |
| [SOURCES.md](./SOURCES.md)               | les sources d'une feature : jetons, destinations, clés d'API                    |
| [NOTIFICATIONS.md](./NOTIFICATIONS.md)   | les canaux par feature et la sélection par élément                              |
| [MAINTENANCE.md](./MAINTENANCE.md)       | fermer le site ou une feature à l'instant, depuis l'interface, la base ou l'env |
| [LOGS.md](./LOGS.md)                     | où regarder en production : audit, sortie standard, alertes Système             |
| [DEBUG.md](./DEBUG.md)                   | la page Tests et débogage : essais sans résidu, mesures, mails, suivi d'usage   |

## Features

| Doc                                                | Quoi                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| [Audience](../features/audience/README.md)         | le suivi d'usage des sites livrés                                 |
| [Sauvegardes](../features/backup/README.md)        | les sauvegardes : sources, destinations, chiffrement des archives |
| [Bases de données](../features/database/README.md) | l'inventaire des bases et leurs alertes                           |
| [Déploiements](../features/deploy/README.md)       | les mises en production via Dokploy ou GitHub Actions             |
| [Finances](../features/finance/README.md)          | la trésorerie de l'activité                                       |
| [Git](../features/git/README.md)                   | les dépôts de l'espace et leur cache                              |
| [Mail](../features/mail/README.md)                 | les boîtes mail de l'espace, leurs deux paliers, les alertes      |
| [Appareils](../features/devices/README.md)         | la supervision des machines enrôlées                              |
| [Notes](../features/notes/README.md)               | les notes et leurs dossiers, la note privée, la note projetée     |
| [Projets](../features/projects/README.md)          | le pilotage du travail, et ses liaisons vers les objets d'espace  |
| [Sentinelle](../features/sentinel/README.md)       | la posture de sécurité des machines                               |
| [Uptime](../features/uptime/README.md)             | la disponibilité des services externes                            |
