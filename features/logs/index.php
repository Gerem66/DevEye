<?php

    /**
     * @var User $user
     * @var DataBase $db
     * @var Feature[] $features
     */

    /**
     * @param DataBase $db
     * @param User $user
     * @param string $type
     * @param array $args
     * @return array Array returned to the client
     */
    $action = function($db, $user, $type, $args) {
        if ($type === 'dbtable') {
            return DBTableCommand($db, $args, 10);
        }
    };

    $logsTable = AddDataTable($db, 'Logs', 0, 10);
    $variables = array(
        'username' => $user->Username,
        'logsTable' => $logsTable
    );

    return ImportHTML(__DIR__.'/index.html', $variables);

?>