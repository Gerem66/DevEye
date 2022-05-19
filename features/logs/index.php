<?php

    /** @var DataBase $db */

    $logsCount = 10;
    $logStarts = 0 * $logsCount;
    $logs = GetRows($db, 'Logs', $logStarts, $logsCount);

    $logsIDs = $db->QueryArray("SELECT `ID` FROM `Logs`");
    $logsLength = count($logsIDs);
    $maxPage = ceil($logsLength / $logsCount);

    if (isset($post['type'])) {
        DBTableCommand($db, $post, $logsCount);
    }

    $variables = array(
        'username' => $user->Username,
        'maxpage' => $maxPage,
        'logsContent' => TbodyFromDB($logs)
    );

    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>