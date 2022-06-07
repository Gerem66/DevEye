<?php

    /**
     * @var User $user
     * @var DataBase $db
     * @var Feature[] $features
     */

    /**
     * Here you can add some files to store functions like this:
     * include_once(__DIR__.'/utils.php');
     * 
     * Warning: you can't use the same name for functions in different files.
     * Warning: don't create functions in this file.
     */

    /**
     * Function called to perform server side operations\
     * once the page is loaded (often user actions)
     * @param DataBase $db
     * @param User $user
     * @param string $type
     * @param array $args
     * @return string String returned to the client
     */
    $action = function($db, $user, $type, $args) {
    };

    /**
     * Here you can add your own code, and return as string
     */

    $variables = array(
        'username' => $user->Username
    );
    return ImportHTML(__DIR__.'/index.html', $variables);

?>