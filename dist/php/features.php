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
        AddFeature(2, 'Features', 'Mails [lecture]', 'mails', 'envelope', false, false),
        AddFeature(2, 'Features', 'Projets', 'projects', 'project-diagram'),
        //AddFeature(3, 'Features', 'Comptes', 'accounts', 'file-invoice', false, false),
        AddFeature(1, 'Features', 'Journal de bord', 'logbook', 'clipboard-check', true),
        AddFeature(1, 'Features', 'Mots de passe', 'passwords', 'lock', true),
        AddFeature(1, 'Features', 'Proxiwash', 'washing-machine', 'tshirt'),
        AddFeature(1, 'Features', 'Settings', 'settings', 'cog', false, true, false),

        AddFeature(2, 'Services', 'GHost', 'ghost', 'ghost'),
        AddFeature(2, 'Services', 'Gyrics', 'gyrics', 'music', false),
        AddFeature(2, 'Services', 'VM', 'virtual-machine', 'laptop-code'),
        
        AddFeature(3, 'Admin', 'Base de données', 'database', 'database'),
        AddFeature(3, 'Admin', 'Logs', 'logs', 'clipboard-list'),

        AddFeature(3, 'En cours de dev', 'Trading Bot', 'tradingbot', 'robot', false, false, false)

        //AddFeature(3, 'Pas encore dev', 'Panneau de contrôle', 'dashboard', 'tachometer-alt', false, false, false)
    ];

?>