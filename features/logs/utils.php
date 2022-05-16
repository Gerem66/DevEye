<?php

    /**
     * @param DataBase $db
     * @param int $starts
     * @param int $count
     * @param string $get
     */
    function GetLogs($db, $starts, $count, $get = '*') {
        return $db->QueryArray("SELECT * FROM `Logs` ORDER BY `ID` DESC LIMIT $count OFFSET $starts");
    }

    function LogsToTable($logs) {
        $content = "";
        foreach ($logs as $log) {
            $content .= "<tr>";
            foreach ($log as $key => $value) {
                $content .= "<td>$value</td>";
            }
            $content .= "</tr>";
        }
        return $content;
    }

?>