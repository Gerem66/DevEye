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
    require('dist/php/features.php');

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
    $user = unserialize($_SESSION['USER']);

    // Header
    $scriptsArray = GetJavascriptFiles('features/');
    $scriptsHTML = array_map(fn($script) => "<script src=\"$script\"></script>", $scriptsArray);

    // Sidebar
    DefineFeatures($db);
    $sidebar = file_get_contents('dist/html/sidebar.html');
    $sidebar = str_replace('%content%', GenerateSidebar(), $sidebar);
    $sidebar = str_replace('%avatar%', $user->Avatar, $sidebar);
    $sidebar = str_replace('%username%', $user->Username, $sidebar);

    require('dist/html/home_body.html');
    echo($sidebar);
    echo('<div id="main-content"></div>');
    echo(implode('', $scriptsHTML));
    require('dist/html/home_footer.html');

?>