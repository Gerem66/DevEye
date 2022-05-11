<?php

    function AddFeature($minLvl, $category, $title, $page, $icon, $canDisable = true) {
        return array(
            'minLvl' => $minLvl,
            'category' => $category,
            'title' => $title,
            'page' => $page,
            'icon' => $icon,
            'canDisable' => $canDisable
        );
    }

    /*$_SESSION['FEATURES'] = [
        //AddFeature(2, 'Dev', 'Panneau de contrôle', 'dashboard', 'tachometer-alt'),

        //AddFeature(2, 'Projet - GameLife', 'BDD - Public', 'database-gl', 'database'),
        //AddFeature(2, 'Projet - GameLife', 'BDD - Dev', 'database-dev-gl', 'database'),

        //AddFeature(1, 'Perso', 'Mails [lecture]', 'mails', 'envelope', false),
        //AddFeature(1, 'Perso', 'Projets', 'projects', 'project-diagram'),
        //AddFeature(1, 'Perso', 'Journal de bord', 'logbook', 'clipboard-check'),
        //AddFeature(1, 'Perso', 'Mots de passe', 'passwords', 'lock'),
        //AddFeature(1, 'Perso', 'Settings', 'settings', 'cog', false),

        AddFeature(3, 'Admin', 'Base de données', 'database', 'database'),
        AddFeature(3, 'Admin', 'Logs', 'logs', 'clipboard-list')

        //AddFeature(3, 'En cours de dev', 'Features', 'Comptes', 'accounts', 'file-invoice', false),
        //AddFeature(3, 'En cours de dev', 'Trading Bot', 'tradingbot', 'robot', false, false)
    ];*/

    /** Exemple d'une version OK */

    /**
     * Avatar (profil + settings)
     * 
     * Perso
     *  - Journal de bord
     *  - Mails
     *  - Projets
     *  - Mots de passe
     * 
     * Oxy
     *  - Chat
     *  - Projets
     *    - GameLife
     *      - Journal de bord
     *      - Base de donnée
     */

    function Category($title, $icon) {
        return array(
            'title' => $title,
            'icon' => $icon
        );
    }

    function Feature($title, $page, $icon) {
        return array(
            'title' => $title,
            'page' => $page,
            'icon' => $icon
        );
    }

    $ALL_GROUP_FEATURES = array(
        'test' => Category('Test', 'tachometer-alt')
    );

    $ALL_FEATURES = array(
        'logs' => Feature('Logs', 'logs', 'logs'),
        'database' => Feature('Base de données', 'database', 'database')
    );

    $_SESSION['FEATURES'] = array(
        'Admin' => array(
            'logs',
            'logs',
            'test' => array(
                'database',
                'test' => array(
                    'logs',
                    'logs'
                ),
                'logs'
            )
        )
    );

?>