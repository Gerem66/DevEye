<?php

    require_once(__DIR__.'/utils.php');

    $post_id = isset($_REQUEST['id']) ? $_REQUEST['id'] : 0;

    $logs_count = $post_id <= 0 ? 10 : $post_id;
    $logs = GetLogsList();
    $logs_content = LogsToTable($logs, $logs_count);

    $bt_showall_id = $post_id == 0 ? '999' : '0';
    $btShowallText = intval($post_id) > 10 ? 'Réduire les logs' : 'Afficher tous les logs';
    $variables = array(
        'username' => $user->Username,
        'logsContent' => $logs_content,
        'buttonText' => $btShowallText,
    );

    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>