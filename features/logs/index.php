<?php

    /** @var DataBase $db */

    /**
     * @param DataBase $db
     * @param int $starts
     * @param int $count
     * @param string $get
     */
    function GetLogs($db, $starts, $count, $get = '*') {
        return $db->QueryArray("SELECT $get FROM `Logs` ORDER BY `ID` DESC LIMIT $count OFFSET $starts");
    }

    $logsCount = 15;
    $logStarts = 0 * $logsCount;
    $logs = GetLogs($db, $logStarts, $logsCount);

    $logsIDs = $db->QueryArray("SELECT `ID` FROM `Logs`");
    $logsLength = count($logsIDs);
    $maxPage = ceil($logsLength / $logsCount);

    if (isset($post['type']) && $post['type'] === 'cellchange') {
        $status = array();
        $result = $db->Query("UPDATE `{$post['table']}` SET `{$post['column']}` = '{$post['value']}' WHERE `ID` = {$post['ID']}");
        $status['status'] = $result !== false ? 'ok' : 'error';
        echo(json_encode($status));
        exit();
    }

    if (isset($post['type']) && $post['type'] === 'rowremove') {
        $status = array();
        $result = $db->Query("DELETE FROM `{$post['table']}` WHERE `ID` = {$post['ID']}");
        $status['status'] = 'error';
        if ($result !== false) {
            $logStarts = ($post['page'] - 1) * $logsCount;
            $logs = GetLogs($db, $logStarts, $logsCount);
            $status['status'] = 'ok';
            $status['content'] = TbodyFromDB($logs);
        }
        echo(json_encode($status));
        exit();
    }

    if (isset($post['type']) && $post['type'] === 'navigation') {
        $status = array();
        $logStarts = ($post['page'] - 1) * $logsCount;
        $logs = GetLogs($db, $logStarts, $logsCount);

        $logsIDs = $db->QueryArray("SELECT `ID` FROM `Logs`");
        $logsLength = count($logsIDs);
        $maxPage = ceil($logsLength / $logsCount);

        $status['status'] = 'ok';
        $status['newPage'] = $post['page'];
        $status['maxPage'] = $maxPage;
        $status['content'] = TbodyFromDB($logs);
        echo(json_encode($status));
        exit();
    }

    $variables = array(
        'username' => $user->Username,
        'maxpage' => $maxPage,
        'logsContent' => TbodyFromDB($logs)
    );

    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>