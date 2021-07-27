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
        AddFeature(1, 'Features', 'Journal de bord', 'logbook', 'clipboard-check', true),
        AddFeature(1, 'Features', 'Mots de passe', 'passwords', 'lock', true),
        AddFeature(2, 'Features', 'GHost', 'ghost', 'ghost'),
        AddFeature(2, 'Features', 'Gyrics', 'gyrics', 'music', false),
        AddFeature(3, 'Features', 'VM', 'virtual-machine', 'laptop-code'),
        AddFeature(1, 'Features', 'Proxiwash', 'washing-machine', 'tshirt'),
        AddFeature(1, 'Features', 'Settings', 'settings', 'cog', false, true, false),

        AddFeature(3, 'Admin', 'Base de données', 'database', 'database'),
        AddFeature(3, 'Admin', 'Logs', 'logs', 'clipboard-list'),

        AddFeature(3, 'En dev', 'Panneau de contrôle', 'dashboard', 'tachometer-alt', false, false, false),
        AddFeature(3, 'En dev', 'Comptes', 'accounts', 'file-invoice', false, false, false)
    ];

?>