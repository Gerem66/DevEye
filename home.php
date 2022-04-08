<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require('dist/php/bdd.php');
    require('dist/php/user.php');
    require('dist/php/functions.php');
    require('dist/php/features.php');

    // Connection
    if (array_key_exists('bt_connect', $_POST)) {
        Connect();
    }

    // Redirect if unconnected
    if (!isset($_SESSION['STATUS']) || $_SESSION['STATUS'] < 0 || $_SESSION['STATUS'] > 4) {
        $_SESSION['CONNECTED'] = -1;
        header('Location: ./');
        exit();
    }

    // Direct load page (instead of 'user')
    $redirect = 'user';
    /*if (isset($_SESSION['redirect'])) {
        $redirect = $_SESSION['redirect'];
        unset($_SESSION['redirect']);
    } else {
        $status = $_SESSION['STATUS'];
        $dp = $_SESSION['DEFAULT_PAGE'];
        $features = $_SESSION['FEATURES'];
        if ($dp >= 0 && $dp < count($features)) {
            $settings = $_SESSION['SETTINGS'];
            $enabled = SettingsEnabled($settings, $dp);
            extract($features[$dp]);
            if ($enabled && $status >= $minLvl && $title && $canDisable) {
                $redirect = $page;
            }
        }
    }*/

    // Header
    require('dist/html/home_body.html');
    require('dist/html/sidebar.php');
    echo('<div id="main-content"></div>');
    echo('<!-- Utils  --><script src="dist/js/utils.js"></script>');
    echo('<!-- Pages  --><script src="dist/js/page.js"></script>');
    echo('<!-- Navbar --><script src="dist/js/navbar.js"></script>');
    echo('<!-- Script --><script src="dist/js/home.js"></script>');
    require('dist/html/home_footer.html');

?>