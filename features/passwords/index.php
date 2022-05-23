<?php

    /** @var DataBase $db */

    $variables = array(
        'username' => $user->Username
    );

    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>