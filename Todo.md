# Oxy gestion
- [x] Login / encryptor
- [ ] Structure du home
- [ ] Sidebar
- [ ] Features
    - [ ] Management
    - [ ] Projets
    - [ ] Perso
    - [ ] Admin
- [ ] Panels
    - [ ] Voir les users connectés
    - [ ] Chat (+ images, ghost, etc)

## A définir
- Le nom de la catégorie "perso" qui ne signifie pas forcément perso
- La manière de sélectionner le contexte pour les features "perso"
    - Dans la barre en haut centré ou à droite
- Création de mails depuis la page profil ou entreprise ?

## Features
* Management
    - Profil
        - [ ] Visionner ses informations
        - [ ] Édition (mdp)
        - [ ] Ajouter une pdp (remplacer celle par défaut)
            - [ ] Importation d'un png
                - [ ] Optimisation (réduction)
                - [ ] Import sur le serveur
                - [ ] Ajout du path de l'icone dans la bdd
        - [ ] Possibilité d'ajouter des mails (oxyfoo.com) (limité à 10)
        - [ ] Ajouter des intégrations ? (discord, spotify, ...)
    - Gestion des entreprises
        - [ ] Ajouter des personnes
        - [ ] Supprimer des personnes
        - [ ] Ajouter des rôles
        - [ ] Retirer des rôles
        - [ ] Modifier les rôles des membres (si on a les droits / admin)

* 1 onglet par projet (si au moins une de ses features est activée)

* Perso
    - [ ] Mails
        - [ ] Lecture
            - [ ] Optimisations (lecture des derniers ? Stockage sur le serv ?)
            - [ ] Téléchargement des pièces jointes
            - [ ] Fonctions de recherche
            - [ ] Fonctionnalités avancées (labels, favoris...)
        - [ ] Envoi
            - [ ] Édition du texte
            - [ ] Ajout de pièces jointes
            - [ ] Modification des meta data
        - [ ] Ajouter le mail automatiquement si il a été créé depuis le profil

    - [ ] Projets
        - [ ] Affichage du tableau avec les projets
        - [ ] Ajouter des projets
            - [ ] Page d'édition (description)
            - [ ] Possibilité d'ajouter des bdd
            - [ ] Kanban + changelog
            - [ ] Autres (carte mentale d'idées)
        - [ ] Modifier le dashboard du projet
            - [ ] Linker des données
            - [ ] Définir le type (valeur, tableau, évolution, ...)
            - [ ] Changer l'ordre des données
            - [ ] Récupérer une nouvelle valeur manuellement (bouton refresh)
            - [ ] Définir le temps pour stocker les nouvelles valeurs automatiquement
                - [ ] Envoyer une notif en cas d'échec

    - [ ] Notes
        - [ ] Ajouter des bloc-notes
        - [ ] Supprimer des bloc-notes
        - [ ] Visionner un bloc-note
        - [ ] Éditer des bloc-notes
            - [ ] Modifier le titre
            - [ ] Exécuter en MD
            - [ ] Mettre en bouton d'aide avec les indications des commandes MD

    - [ ] Mots de passe
        - Catégories
            - [ ] Ajouter
            - [ ] Modifier
            - [ ] Supprimer
            - [ ] Fermée par défaut
            - [ ] Toutes les fermer (ouvrir si elles le sont déjà)
        - Mot de passe dans les catégories
            - [ ] Ajouter
            - [ ] Modifier
            - [ ] Supprimer
            - [ ] Fonction de recherche (sans ouvrir les catégories)
        - Fonctionnalité avancées
            - [ ] Ajouter un bouton pour vérifier la validité du compte automatiquement

    - [ ] Settings
        - Perso
            - [ ] Page de démarrage
            - [ ] Dés/Activer les features de chaque projets
            - [ ] Dés/Activer les features de base (mot de passe, mail, ...)
            - [ ] Modification de l'ordre

* Admin
    - [ ] Accès à la bdd de la plateforme
    - [ ] Accès aux logs globaux de la plateforme

## App
* Connexion
* Faire un système de notification (perso/projet/entreprise) (visible aussi sur le site)
* Coder un système de double authentification
    - A valider lors de la connexion depuis une autre ip (expiration (1 mois ?) ? Paramétrable depuis l'app ?)

## Server
* Anti spam
    - DDOS, n'affiche rien au delà d'un certain nombre par seconde (et par ip)
    - Envoyer une notif aux admin
* Trop de tentatives de connexion échouée
    - Envoyer une notif à l'admin et à l'user concerné