<?php

    //$curr = 'database-dev-gl';
    //$credentials = [ 'localhost', 'u444572210_GameLifeDev', 'u444572210_GLAdminDev', 'T5*JSh;d' ];

    /**
     * @var User $user
     * @var DataBase $db
     * @var Feature[] $features
     */

    include_once(__DIR__.'/utils.php');

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

    $rowsCount = 10;
    $t1 = microtime(true);
    $tables = $db->GetTables();
    $t2 = microtime(true);
    $tt = ($t2 - $t1) * 1000;
    echo("[$tt]");
    $tablesContent = '';
    foreach ($tables as $table) {
        $t1 = microtime(true);
        $tablesContent .= AddDataTable($db, $table, 0, $rowsCount);
        $t2 = microtime(true);
        $tt = ($t2 - $t1) * 1000;
        echo("[$tt]");
    }

    $variables = array(
        'username' => $user->Username,
        'tablesContent' => $tablesContent
    );
    return ImportHTML(__DIR__.'/index.html', $variables);

?>