<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require('dist/php/sql/sql.php');
    require('dist/php/user.php');
    require('dist/php/utils.php');
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

    // Header
    $scriptsArray = GetJavascriptFiles('features/');
    $scriptsHTML = array_map(fn($script) => "<script src=\"$script\"></script>", $scriptsArray);

    require('dist/html/home_body.html');
    require('dist/html/sidebar.php');
    echo('<div id="main-content"></div>');
    echo(implode('', $scriptsHTML));
    require('dist/html/home_footer.html');

?>