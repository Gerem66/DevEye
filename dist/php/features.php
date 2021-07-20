<?php

    function AddFeature($minLvl, $title, $page, $icon, $collab = false, $finished = true, $canDisable = true) {
        return array(
            'minLvl' => $minLvl,
            'title' => $title,
            'page' => $page,
            'icon' => $icon,
            'collab' => $collab,
            'finished' => $finished,
            'canDisable' => $canDisable
        );
    }

    $_SESSION['FEATURES'] = [
        AddFeature(3, 'Projets', 'projects', 'project-diagram', false, false),
        AddFeature(2, 'Mails [lecture]', 'mails', 'envelope', false, false),
        AddFeature(1, 'Journal de bord', 'logbook', 'clipboard-check', true),
        AddFeature(1, 'Mots de passe', 'passwords', 'lock', true),
        AddFeature(2, 'GHost', 'ghost', 'ghost'),
        AddFeature(2, 'Gyrics', 'gyrics', 'music', false),
        AddFeature(1, 'Proxiwash', 'washing-machine', 'tshirt'),
        AddFeature(2, 'Logs', 'logs', 'clipboard-list'),
        AddFeature(1, 'Settings', 'settings', 'cog', false, true, false),

        AddFeature(3, '', 'user', '', false, false, false),
        AddFeature(3, 'Panneau de contrôle', 'dashboard', 'tachometer-alt', false, false, false),
        AddFeature(3, 'Comptes', 'accounts', 'file-invoice', false, false, false)
    ];

?>