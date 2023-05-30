<?php

/**
 * @param DataBase $db Database name
 * @param int $UID
 * @param int $level Level of action:
 * - 0: Log for monitoring or debugging
 * - 1: Log for important events
 * - 2: Log for critical events
 * @param string $type Type of action:
 * - login: The user tries to log in
 * - logout: The user tries to log out
 * - update: The user tries to update his profile
 * @param string $description
 * @return bool True if the query was successful
 */
function AddLog($db, $UID, $level, $type, $description) {
    $IP = $db->GetClientIP();
    $args = array($UID, $IP, $level, $type, $description);
    $command = 'INSERT INTO TABLE (`UID`, `IP`, `Level`, `Type`, `Description`) VALUES (?, ?, ?, ?, ?)';
    $result = $db->QueryPrepare('Logs', $command, 'isiss', $args);
    return $result !== false;
}

?>