<?php

    require(__DIR__.'/class/client.php');
    require(__DIR__.'/class/wss.php');
    require(__DIR__.'/utils/mask.php');

    error_reporting(E_ERROR);   // To hide timeout warnings
    set_time_limit(0);          // disable timeout
    ob_implicit_flush();        // disable output caching 

    $wss = new WSS();
    $wss->run();

?>