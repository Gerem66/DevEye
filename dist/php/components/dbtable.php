<?php

    /**
     * @param DataBase $db
     * @param string $table
     */
    function GetTableLength($db, $table) {
        $query = "SELECT COUNT(*) FROM `$table`";
        $result = $db->Query($query);
        $row = $result->fetch_row();
        return $row[0];
    }

    /**
     * @param DataBase $db
     * @param string $table
     */
    function GetHeaders($db, $table) {
        $rawHeaders = $db->QueryArray("SHOW COLUMNS FROM `$table`");
        return array_map(fn($header) => $header['Field'], $rawHeaders);
    }

    /**
     * @param DataBase $db
     * @param string $table
     * @param int $starts
     * @param int $count
     */
    function GetRows($db, $table, $starts, $count) {
        return $db->QueryArray("SELECT * FROM `$table` ORDER BY `ID` DESC LIMIT $count OFFSET $starts");
    }

    function TheadFromDB($headers) {
        $pourcentage = 100 / count($headers);
        $getHead = fn($h) => "<th style='width: $pourcentage%;'>{$h}</th>";
        $tableHead = implode('', array_map($getHead, $headers));
        return "<tr>$tableHead</tr>";
    }

    function TbodyFromDB($items) {
        $content = '';
        foreach ($items as $item) {
            $ID = $item['ID'];
            $content .= "<tr>";
            foreach ($item as $key => $value) {
                $content .= "<td data-id='$ID' data-column='$key'>$value</td>";
            }
            $content .= "</tr>";
        }
        return $content;
    }

    /**
     * @param DataBase $db
     * @param array $post
     * @param int $rowsCount
     */
    function DBTableCommand($db, $post, $rowsCount = 10) {
        $status = array('status' => 'error');

        if ($post['type'] === 'cellchange') {
            $result = $db->Query("UPDATE `{$post['table']}` SET `{$post['column']}` = '{$post['value']}' WHERE `ID` = {$post['ID']}");
            if ($result !== false) {
                $status['status'] = 'ok';
            }
        }

        if ($post['type'] === 'rowadd') {
            $result = $db->Query("INSERT INTO `{$post['table']}` (`ID`) VALUES (NULL)");
            if ($result !== false) {
                $logs = GetRows($db, $post['table'], 0, $rowsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
            } else {
                $status['message'] = $db->GetLastError();
            }
        }

        if ($post['type'] === 'rowremove') {
            $result = $db->Query("DELETE FROM `{$post['table']}` WHERE `ID` = {$post['ID']}");
            $status['status'] = 'error';
            if ($result !== false) {
                $logStarts = ($post['page'] - 1) * $rowsCount;
                $logs = GetRows($db, $post['table'], $logStarts, $rowsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
            }
        }

        if ($post['type'] === 'navigation') {
            $logStarts = ($post['page'] - 1) * $rowsCount;
            $logs = GetRows($db, $post['table'], $logStarts, $rowsCount);

            $logsIDs = $db->QueryArray("SELECT `ID` FROM `Logs`");
            $logsLength = count($logsIDs);
            $maxPage = ceil($logsLength / $rowsCount);

            $status['status'] = 'ok';
            $status['newPage'] = $post['page'];
            $status['maxPage'] = $maxPage;
            $status['content'] = TbodyFromDB($logs);
        }

        echo(json_encode($status));
        exit();
    }

?>