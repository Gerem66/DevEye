<?php

    function GetLogsList() {
        $db = new DataBase();
        $result = $db->Query("SELECT * FROM `Logs`");

        $logs = array();
        while ($r = $result->fetch_assoc()) {
            if (!$r) break;
            $ID = $r['ID'];
            $UID = $r['UID'];
            $IP = $r['IP'];
            $Message = $r['Type'];
            $Message = $r['Description'];
            $Date = $r['Date'];
            array_push($logs, [$ID, $UID, $IP, $Message, $Date]);
        }
        return $logs;
    }

    function LogsToTable($logs, $number) {
        $content = "";

        $c = count($logs);
        if ($number == 999 || $number > $c) $number = $c;
        for ($i = 0; $i < $number; $i++) {
            if ($c - $i - 1 < 0) break;
            $ID = $logs[$c - $i - 1][0];
            $UID = $logs[$c - $i - 1][1];
            $IP = $logs[$c - $i - 1][2];
            $Message = $logs[$c - $i - 1][3];
            $Date = $logs[$c - $i - 1][4];
            $content .=    "<tr>
                                <td>$ID</td>
                                <td>$UID</td>
                                <td>$IP</td>
                                <td>$Message</td>
                                <td>$Date</td>
                            </tr>";
        }

        return $content;
    }

?>