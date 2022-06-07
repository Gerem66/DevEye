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
     * @return string String returned to the client
     */
    $action = function($db, $user, $type, $args) {
        if ($type === 'dbtable') {
            return DBTableCommand($db, $args, 10);
        }
    };


    $logsCount = 10;
    $logStarts = 0 * $logsCount;
    $logs = GetRows($db, 'Logs', $logStarts, $logsCount);
    $logsLength = $db->GetTableLength('Logs');
    $maxPage = ceil($logsLength / $logsCount);

    $variables = array(
        'username' => $user->Username,
        'maxpage' => $maxPage,
        'logsContent' => TbodyFromDB($logs)
    );
    return ImportHTML(__DIR__.'/index.html', $variables);

?>