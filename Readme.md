# Oxy Gestion

## Références
### Développement
* [PHP Sandbox](https://onlinephp.io/)
* [PHP Code checker](https://phpcodechecker.com/)
* [SVG Repo](https://www.svgrepo.com/)

### Sécu
* [PHP config](https://www.php.net/manual/fr/session.security.ini.php)
* [Blog congif](https://www.cloudways.com/blog/php-session-security/)
* [Forum PHP Encryption](https://stackoverflow.com/questions/6770370/aes-256-encryption-in-php)

### Ressources
* [Logo principal](https://fr.vecteezy.com/art-vectoriel/585533-modele-de-conception-de-logo-vectoriel-eye-care)

### Serveur
* [WSS start script](https://stackoverflow.com/questions/35031603/create-php-websocket-with-ssl)
* [PEM file](https://github.com/ratchetphp/Ratchet/issues/489)
* [Un/mask functions](https://www.php.net/manual/fr/function.stream-socket-server.php)
* Make PEM files from TLS certificate
    - sudo openssl rsa -in /etc/ssl/private/private.key -text > private.pem
    - sudo openssl x509 -inform PEM -in /etc/ssl/certificate.crt > public.pem

## Manips
### Ajouter une feature
* Code
    - Créer un répertoire : ./features/FEATURE_NAME (dupliquer le répertoire "_template")
    - Code principal en `PHP` et/ou `HTML`:
        - Le script index.php est appelé lors de l'ouverture de la feature
        - Possibilité d'ajouter d'autres fichiers PHP, en les important depuis index.php
        - Idem pour les fichiers HTML
    - Créer le code client principal en `JS` :
        - main.js (extend de la classe Feature) est appelé lors de l'ouverture du site, mais les fonctions de l'extend sont exécutés à l'ouverture/fermeture de la feature
        - Possibilité d'ajouter d'autres fichiers, ils seront tous automatiquement appelés à l'ouverture du site (attention à l'overloading)
    - Ajouter du `css`:
        - Ajouter les fichiers css directement dans le code source du site (Penser à les importer si besoin dans le home.html)
        - Ou pour le css uniquement lié à la page, l'ajouter directement dans le répertoire, il sera importé automatiquement à l'ouverture du site (tous les css sont importés au démarrage, donc attention à l'overloading)
* Base de données
    - Ajouter la feature dans la table 'Features' (pour autoriser la page dans la sidebar / management)
    - [Optionnel] La plupart des features ont leur propre table (avec un "_" devant)
* Autocompletion
    - Ajouter le nom de la feature dans la classe JS "Page.js"
* Htaccess
    - Ajouter le nom de la feature dans le htaccess (pour autoriser le chargement de la page)