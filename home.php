<?php


    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require('dist/php/user.php');
    require('dist/php/sql/sql.php');
    require('dist/php/class/user.php');
    require('dist/php/utils/functions.php');

    // TODO - Disable refresh (and reload manually by websocket)





?>