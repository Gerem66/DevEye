<?php

    /** @var DataBase $db */

    require_once(__DIR__.'/utils.php');

    $logsCount = 15;



    if (!isset($_SESSION['logs-page'])) {
        $_SESSION['logs-page'] = 0;
    }
    if (isset($_POST['type'])) {
        $type = $_POST['type'];
        if ($type === 'next' && $_SESSION['logs-page'] > 0) {
            $_SESSION['logs-page']--;
        } else if ($type === 'prev') {
            $_SESSION['logs-page']++;
            $logs = GetLogs($db, $_SESSION['logs-page'] * $logsCount, $logsCount, 'ID');
            if (count($logs) <= 0) $_SESSION['logs-page']--;
        } else if ($type === 'last') {
            $_SESSION['logs-page'] = 0;
        }
    }

    $logStarts = $_SESSION['logs-page'] * $logsCount;
    $logs = GetLogs($db, $logStarts, $logsCount);

    $firstID = reset($logs)['ID'];
    $lastID = end($logs)['ID'];
    $variables = array(
        'username' => $user->Username,
        'logsTitle' => "$firstID - $lastID",
        'logsContent' => LogsToTable($logs)
    );

    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>