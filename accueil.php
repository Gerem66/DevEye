<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require("dist/php/bdd.php");
    require("dist/php/user.php");
    require("dist/php/functions.php");
    require("dist/php/features.php");

    // Link connection
    if (isset($_SESSION['POST_DATA'])) {
        $_POST = $_SESSION['POST_DATA'];
        unset($_SESSION['POST_DATA']);
    }

    // Connection
    if (array_key_exists('bt_connect', $_POST)) {
        Connect();
    }

    // Guest connection - Disabled for now
    if (array_key_exists('bt_guest', $_POST)) {
        SetUser(0, 'GUEST', date('d/m/y - H:i'), 'Aucune', 0, 0, 'Aucune', 'user-icon.png');
        AddLog($_SESSION['ID'], "Guest connection successfully.");
    }

    // Redirect if unconnected
    if (!isset($_SESSION['STATUS']) || $_SESSION['STATUS'] < 0 || $_SESSION['STATUS'] > 4) {
        $_SESSION['CONNECTED'] = -1;
        header('Location: ./');
        exit();
    }

    // Direct load page (instead of 'user')
    $redirect = 'user';
    if (isset($_SESSION['redirect'])) {
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
    }

    // Header
    require("dist/pages/body.html");
    require("dist/pages/sidebar.php");

    // Body
    echo('<div id="main-content">');
    echo('</div>');

    // Footer
    require("dist/pages/footer.html");

    echo('<!-- REQUIRED SCRIPTS   -->');
    echo('<!-- jQuery             --><script src="plugins/jquery/jquery.min.js"></script>');
    echo('<!-- jQuery UI 1.11.4   --><script src="plugins/jquery-ui/jquery-ui.min.js"></script>');
    echo('<!-- Bootstrap 4        --><script src="plugins/bootstrap/js/bootstrap.bundle.min.js"></script>');
    echo('<!-- AdminLTE App       --><script src="dist/js/adminlte.min.js"></script>');
    echo('<!-- Dynamic page load  --><script src="dist/js/dynamic_load.js"></script>');
    echo('<!-- Prevent Resub.     --><script src="dist/js/prevent_resubmission_alert.js"></script>');

    // Features scripts
    echo('<!-- Mails          --><script src="features/scripts/mails.js"></script>');
    echo('<!-- Projects       --><script src="features/scripts/projects.js"></script>');
    echo('<!-- Logbook & pwds --><script src="features/scripts/blocnote.js"></script>');
    echo('<!-- User           --><script src="features/scripts/user.js"></script>');
    echo('<!-- Settings       --><script src="features/scripts/settings.js"></script>');
    echo('<!-- Database       --><script src="features/scripts/database.js"></script>');
    echo('<!-- Functions      --><script src="features/scripts/functions.js"></script>');

    require("dist/pages/body_end.html");
    echo("<script>LoadPage('$redirect');</script>");

?>