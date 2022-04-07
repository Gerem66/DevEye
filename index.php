<?php

    // Show encryptor page
    if ($_GET['action'] === 'encryptor') {
        require('./dist/php/encryptor.php');
        exit();
    }

    // Start login page
    session_start();
    require("dist/php/user.php");
    require("dist/php/bdd.php");

    // Disconnect
    if (isset($_REQUEST['disconnect'])) {
        Disconnect();
    }

    // Already connected
    if (isset($_SESSION['STATUS'], $_SESSION['CONNECTED']) && $_SESSION['STATUS'] >= 0 && $_SESSION['STATUS'] <= 3 && $_SESSION['CONNECTED'] >= 0) {
        header('Location: ./home');
        exit();
    }

    // Authentication failed
    if (!isset($_SESSION['CONNECTED'])) $_SESSION['CONNECTED'] = 0;
    $is_valid_txt = $_SESSION['CONNECTED'] == -1 ? 'error' : '';
    if ($_SESSION['CONNECTED'] < 0) $_SESSION['CONNECTED'] = 0;

    $content = file_get_contents('./dist/html/login.html');
    $content = str_replace('%error%', $is_valid_txt, $content);
    echo($content);

?>