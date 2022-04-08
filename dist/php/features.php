<?php

    function AddFeature($minLvl, $category, $title, $page, $icon, $collab = false, $finished = true, $canDisable = true) {
        return array(
            'minLvl' => $minLvl,
            'category' => $category,
            'title' => $title,
            'page' => $page,
            'icon' => $icon,
            'collab' => $collab,
            'finished' => $finished,
            'canDisable' => $canDisable
        );
    }

    $_SESSION['FEATURES'] = [
        //AddFeature(2, 'Dev', 'Panneau de contrôle', 'dashboard', 'tachometer-alt'),

        //AddFeature(2, 'Projet - GameLife', 'BDD - Public', 'database-gl', 'database'),
        //AddFeature(2, 'Projet - GameLife', 'BDD - Dev', 'database-dev-gl', 'database'),

        //AddFeature(1, 'Perso', 'Mails [lecture]', 'mails', 'envelope', false, false),
        //AddFeature(1, 'Perso', 'Projets', 'projects', 'project-diagram'),
        //AddFeature(1, 'Perso', 'Journal de bord', 'logbook', 'clipboard-check', true),
        //AddFeature(1, 'Perso', 'Mots de passe', 'passwords', 'lock', true),
        //AddFeature(1, 'Perso', 'Settings', 'settings', 'cog', false, true, false),

        AddFeature(3, 'Admin', 'Base de données', 'database', 'database'),
        //AddFeature(3, 'Admin', 'Logs', 'logs', 'clipboard-list')

        //AddFeature(3, 'En cours de dev', 'Features', 'Comptes', 'accounts', 'file-invoice', false, false),
        //AddFeature(3, 'En cours de dev', 'Trading Bot', 'tradingbot', 'robot', false, false, false)
    ];

?>