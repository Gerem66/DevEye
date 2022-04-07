<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');
    require('dist/php/bdd.php');
    require('dist/php/functions.php');

    // Check user state
    if (!isset($_SESSION['ID'])) {
        die('disconnect');
    }

    $is_page = isset($_GET['page']);
    $get_page = $is_page ? $_GET['page'] : '';
    $post_id = GetPostValue('id', 0);

    if (CheckPage($get_page)) {
        require("./features/$get_page.php");
    }

?>