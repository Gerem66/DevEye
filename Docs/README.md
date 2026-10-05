# Les docs de DevEye

Chaque document dit **pourquoi** les choses sont ainsi ; le code dit comment.
Ce dossier porte le transverse ; la doc d'une feature vit dans son module,
à côté de son manifest (`features/<id>/README.md`). L'installation et le
lancement sont dans le [README de la racine](../README.md#quick-start).

## Guides

| Doc                                              | Quoi                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| [CREATING_A_FEATURE.md](./CREATING_A_FEATURE.md) | la checklist d'une nouvelle feature, fichier par fichier |
| [FEATURE_SDK.md](./FEATURE_SDK.md)               | le SDK des modules de features, côté mainteneur          |

## Systèmes transverses

| Doc                                      | Quoi                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [WORKSPACES.md](./WORKSPACES.md)         | les espaces : isolation, rôles, clés                                                                       |
| [SECURITY_MODEL.md](./SECURITY_MODEL.md) | le chiffrement : étages ouvert et gardé, DEK, mot de passe ; l'agent, CloudSync, Hébergement               |
| [KEY_ROTATION.md](./KEY_ROTATION.md)     | changer la clé serveur (`CRYPT_KEY_A/B`) : ce qu'elle emballe, ce qu'elle dérive, la procédure             |
| [AUTH_PROMPTS.md](./AUTH_PROMPTS.md)     | l'invite de déverrouillage unique, et qui la réutilise                                                     |
| [PERMISSIONS.md](./PERMISSIONS.md)       | les permissions : qui a le droit de quoi                                                                   |
| [SHARING.md](./SHARING.md)               | le partage entre espaces : un élément visible depuis plusieurs espaces                                     |
| [FEDERATION.md](./FEDERATION.md)         | les instances distantes : les espaces d'un autre serveur DevEye dans la même interface                     |
| [LIVE.md](./LIVE.md)                     | la présence en direct : qui est là, où, et ce qui vient de changer                                         |
| [SETTINGS.md](./SETTINGS.md)             | la coquille de réglages unique et son bouton commun                                                        |
| [QUOTAS.md](./QUOTAS.md)                 | offres et quotas : ce que le cœur sait d'une offre, illimité sans module de facturation                    |
| [ACCOUNT_EXPORT.md](./ACCOUNT_EXPORT.md) | l'export des données d'un compte : l'archive, le sort de chaque table                                      |
| [SOURCES.md](./SOURCES.md)               | les sources d'une feature : des réglages d'espace réutilisables, désignés par les éléments                 |
| [NOTIFICATIONS.md](./NOTIFICATIONS.md)   | les canaux d'alerte : où partent les notifications                                                         |
| [MAINTENANCE.md](./MAINTENANCE.md)       | l'accès et la maintenance : inscriptions, priorité aux abonnés, places, fermeture du site ou d'une feature |
| [LOGS.md](./LOGS.md)                     | où regarder en production : audit, sortie standard, alertes Système                                        |
| [STATUS_PAGE.md](./STATUS_PAGE.md)       | la page d'état publique, hors de l'app                                                                     |
| [DEBUG.md](./DEBUG.md)                   | la page Tests et débogage : essais sans résidu, mesures, mails, suivi d'usage, galerie                     |

## Features

| Doc                                                | Quoi                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Appareils](../features/devices/README.md)         | la supervision des machines enrôlées                                                |
| [Audience](../features/audience/README.md)         | le suivi d'usage des sites livrés                                                   |
| [Bases de données](../features/database/README.md) | l'inventaire des bases et leurs alertes                                             |
| [Convertisseur](../features/convert/README.md)     | la conversion de vidéos, de sons, d'images et de documents, côté serveur            |
| [Déploiements](../features/deploy/README.md)       | les mises en production via Dokploy ou GitHub Actions                               |
| [Facturation](../features/invoicing/README.md)     | les devis et les factures d'un espace, le carnet de clients, le suivi du dû         |
| [Finances](../features/finance/README.md)          | la trésorerie de l'activité : comptes, opérations, échéances, TVA                   |
| [Git](../features/git/README.md)                   | les dépôts de l'espace et leur cache                                                |
| [Mail](../features/mail/README.md)                 | les boîtes mail de l'espace, leurs deux paliers, les alertes                        |
| [Notes](../features/notes/README.md)               | les notes et leurs dossiers, la note privée, la note projetée                       |
| [Projets](../features/projects/README.md)          | le pilotage du travail, et ses liaisons vers les objets d'espace                    |
| [Sauvegardes](../features/backup/README.md)        | les sauvegardes : sources, destinations, chiffrement des archives                   |
| [Sentinelle](../features/sentinel/README.md)       | la posture de sécurité des machines                                                 |
| [Serveur mail](../features/mailserver/README.md)   | des boîtes mail sur les domaines de l'espace, servies par DevEye : SMTP, IMAP, DKIM |
| [Uptime](../features/uptime/README.md)             | la disponibilité des services externes                                              |
