# Oxy - Website
## Features
- [x] User
- [x] Journal de bord (+ instance séparée)
- [x] Mots de passe (+ instance séparée)
- [x] Logs
- [x] Settings
- [ ] Mails
- [ ] GHost
- [ ] Projets (+ instance inclu)
- [ ] Trading bot
- [ ] Comptes (+ instance séparée)
- [ ] Panneau de contrôle
- [ ] Spotify

### Peut-être
- [ ] Gestion de projets (pages custom par projets) ?
- [ ] Actu/météo (widget ?)

## TODO
- [x] Supprimer newpaper
- [x] Returer tous les #
- [x] Responsive
- [x] Debug le chargement dynamique (active sidebar)
- [x] Recoder les team (+ icon)
- [ ] Recoder les features pour les centraliser (puis pr les manipuler depuis les settings)
- [ ] Mettre les features ds la bdd ?
- [ ] Modifier le mot de passe
- [ ] Mettre la bottombar dans l'onglet de gauche ou de droite
- [ ] Connexion sans refresh avant d'avoir eu le résultat
- [ ] Restreindre les accès aux scripts
- [x] Logbook et passwords, sauvegarder et charger la page d'après en même temps
- [ ] Ajouter une notif hover pour afficher tous les membres (user)
### Mail
* [ ] Terminer de coder les mails
    - [ ] Lecture
        - [x] Lire tous les mails (suivant / précédant)
        - [x] Lire les différentes catégories
        - [x] Lire chaque mail (parser + bon encodage)
        - [x] Bouton actualiser
        - [x] Navigation dans la boîte mail (page précédante/suivante)
        - [x] Marquer comme lu
    - [ ] Écrire un nouveau mail (ou répondre à un autre)
        - [ ] Page d'écriture (sujet, body, etc)
        - [ ] Envoi
    - [x] Boîtes mail
        - [x] Ajouter une boîte mails
        - [x] Modifier une boîte mails
        - [x] Retirer une boîte mails
    - [ ] Autres features
        - [x] Charger/Sauvegarder le nombre des mails non lus (de toutes les boîtes)
        - [x] Suppression d'un mail / des mails séléctionnés
        - [x] Prévoir la page si aucun mail (page de création d'un mail ?)
        - [x] Gestion des erreurs
        - [ ] Télécharger les pièces jointes
        - [ ] Recherche d'un mail
        - [x] Intégrer les serveurs les plus connus
        - [x] Marquer comme lu/non lu
        - [x] Marquer comme favori
        - [ ] Ajouter une catégorie pr les favoris / non lus
        - [ ] Définir des labels aux mails
        - [ ] Bouton pour actualiser toutes les boîtes mails
        - [x] Nombre de mails non lus par catégories
        - [x] Mot de passe : bouton pr le rendre visible
    - [ ] Mode team (avec toutes les features ci-dessus)
18/26
### Projects
* Liste principale avec TOUS les projets (solo + instance) triés par ordre chronologique
* Affichage du projet (Kanban board)
* Création / édition / paramètres du projet
    - Mode team ou non
    - Supprimer le projets
* Créer les pages:
    - projects-edit.php
    - projects-kanban.php
## Changelog
* 02/07/21
    - Restauration du template
    - Création de la base de donnée
    - Système de connexion
    - Restructuration des pages
* 03/07/21
    - Accès aux pages recodé et optimisées
    - Animation entre les pages
    - Création de la page des mails
* 04/07/21
    - Commencement de la feature mails
        - Ajouter/éditer/supprimer des boîtes mails
* 05/07/21
    - Avancement de la feature mails
        - Lecture de mails
* 06/07/21
    - Finalisation de la feature mails
        - Écriture de mails
    - Réécriture de la structure (team)
    - Optimisations
* 08/07/21
    - Toujours plus d'optimisations (sauvegarde logbook/passwords)
    - Mise en place des settings
    - Création de la feature des mails
* 10/07/21
    - Centraliser toutes les commandes liées à la bdd dans le code existant
    - Afficher le nombre de membres dans "user"
* ...20/07/21
    - Ajout de l'onglet Proxiwash
    - Ajout des settings (+ defaultPage)
    - Intégration de GHost et GyricsDev
    - Projets, dev du tableau principal + Edit + début kanban
    - LogBook : Cochage des cases en un clic
* 21/07/21
    - BDD -> Classe
    - Avancement des projets (kanban drag&drop + cases cochables)

## Sources
* Php : https://www.php.net/
* Parser les mails : https://stackoverflow.com/questions/25491061/how-to-extract-only-html-from-imap-body-result
* Imap attachment : http://www.codediesel.com/php/downloading-gmail-attachments-in-php-an-update/
## Code
JS  : 217
PHP : 780
CSS : 83