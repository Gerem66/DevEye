<?php

    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    error_reporting(E_ALL);     // Default error reporting
    set_time_limit(0);          // Disable time limit for PHP scripts
    ob_implicit_flush();        // Force PHP to flush output buffers

    require(__DIR__.'/class/feature.php');
    require(__DIR__.'/class/instance.php');
    require(__DIR__.'/class/project.php');
    require(__DIR__.'/class/user.php');

    require(__DIR__.'/utils/functions.php');
    require(__DIR__.'/utils/mask.php');
    require(__DIR__.'/utils/sidebar.php');

    require(__DIR__.'/server/client.php');
    require(__DIR__.'/server/wss.php');

    require(__DIR__.'/components/dbtable.php');
    require(__DIR__.'/components/markdown.php');

    require(__DIR__.'/sql/sql.php');
    require(__DIR__.'/global.php');

    $db = new DataBase();
    $rawFeatures = $db->QueryPrepare('Features', "SELECT * FROM TABLE");
    $features = array_map(fn($f) => Feature::Load($f), $rawFeatures);

    $wss = new WSS();
    $wss->run();

?>