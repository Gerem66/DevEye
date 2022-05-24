<?php

    /**
     * @param DataBase $db
     * @param string $table
     * @param int $starts
     * @param int $count
     */
    function GetRows($db, $table, $starts, $count) {
        return $db->QueryPrepare($table, "SELECT * FROM TABLE ORDER BY `ID` DESC LIMIT ? OFFSET ?", 'ii', array($count, $starts));
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
        $table = $post['table'];

        if ($post['type'] === 'cellchange') {
            $column = $post['column'];
            if (!$db->IsSafe($column)) {
                // TODO - Add cheat suspicion
                throw new Exception('Column name is not safe');
            }
            $result = $db->QueryPrepare($table, "UPDATE TABLE SET `$column` = ? WHERE `ID` = ?", 'si', array($post['value'], $post['ID']));
            if ($result !== false) {
                $status['status'] = 'ok';
            }
        }

        if ($post['type'] === 'rowadd') {
            $result = $db->QueryPrepare($table, "INSERT INTO TABLE (`ID`) VALUES (NULL)");
            if ($result !== false) {
                $logs = GetRows($db, $table, 0, $rowsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
                $status['maxPage'] = ceil($db->GetTableLength($table) / $rowsCount);
            } else {
                $status['message'] = $db->GetLastError();
            }
        }

        if ($post['type'] === 'rowremove') {
            $result = $db->QueryPrepare($table, "DELETE FROM TABLE WHERE `ID` = ?", 'i', array($post['ID']));
            $status['status'] = 'error';
            if ($result !== false) {
                $logStarts = ($post['page'] - 1) * $rowsCount;
                $logs = GetRows($db, $table, $logStarts, $rowsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
            }
        }

        if ($post['type'] === 'navigation') {
            $logStarts = ($post['page'] - 1) * $rowsCount;
            $logs = GetRows($db, $table, $logStarts, $rowsCount);
            $maxPage = ceil($db->GetTableLength($table) / $rowsCount);

            $status['status'] = 'ok';
            $status['newPage'] = $post['page'];
            $status['maxPage'] = $maxPage;
            $status['content'] = TbodyFromDB($logs);
        }

        echo(json_encode($status));
        exit();
    }

?>