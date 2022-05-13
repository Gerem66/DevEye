<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require('dist/php/class/feature.php');
    require('dist/php/class/instance.php');
    require('dist/php/class/project.php');
    require('dist/php/class/user.php');

    require('dist/php/sql/sql.php');
    require('dist/php/user.php');
    require('dist/php/utils.php');
    require('dist/php/sidebar.php');

    $db = new DataBase();
    $connected = isset($_SESSION['USER']);

    // Connection
    if (array_key_exists('bt_connect', $_POST)) {
        $connected = Connect($db);
    }

    // Redirect if unconnected
    if (!$connected) {
        $_SESSION['CONNECTED'] = -1;
        header('Location: ./');
        exit();
    }

    /** @var User $user */
    DefineFeatures($db);
    $user = unserialize($_SESSION['USER']);

    // Load
    $sidebar = GenerateSidebar();
    $scriptsJS = GetScriptsFiles('features/', 'js');
    $scriptsCSS = GetScriptsFiles('features/', 'css');
    $scriptsMerge = array_merge($scriptsCSS, $scriptsJS);
    $scripts = implode('', array_map('GetScriptsImports', $scriptsMerge));

    // Load home variables and render
    $home = file_get_contents('dist/html/home.html');
    $home = str_replace('%sidebar%', $sidebar, $home);
    $home = str_replace('%avatar%', $user->Avatar, $home);
    $home = str_replace('%username%', $user->Username, $home);
    $home = str_replace('%scripts%', $scripts, $home);
    echo($home);

?>