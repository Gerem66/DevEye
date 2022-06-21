<?php


    /**
     * @param DataBase $db
     * @param string $table
     * @param int $page
     * @param int $pageLength
     */
    function AddDataTable($db, $table, $page, $pageLength) {
        $headers = $db->GetColumns($table);
        $rows = GetRows($db, $table, $page, $pageLength);
        $lastPage = ceil($db->GetTableLength($table) / $pageLength);

        $tableHead = TheadFromDB($headers);
        $tableBody = TbodyFromDB($rows);

        return "<div class='row'>
                    <div class='card col-full' data-title='$table'>
                        <table class='show-lines' data-maxpage='$lastPage'>
                            <thead>$tableHead</thead>
                            <tbody>$tableBody</tbody>
                        </table>
                    </div>
                </div>";
    }

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
     * @param array $args
     * @param int $rowsCount
     * @return array
     */
    function DBTableCommand($db, $args, $rowsCount = 10) {
        $status = array('status' => 'error');
        $table = $args['table'];

        if ($args['type'] === 'cellchange') {
            $column = $args['column'];
            if (!$db->IsSafe($column)) {
                // TODO - Add cheat suspicion
                throw new Exception('Column name is not safe');
            } else {
                $result = $db->QueryPrepare($table, "UPDATE TABLE SET `$column` = ? WHERE `ID` = ?", 'si', array($args['value'], $args['ID']));
                if ($result !== false) {
                    // Get the new value
                    $result2 = $db->QueryPrepare($table, "SELECT `$column` FROM TABLE WHERE `ID` = ?", 'i', array($args['ID']));
                    if ($result2 !== false) {
                        $status['status'] = 'ok';
                        $status['value'] = $result2[0][$column];
                    }
                }
            }
        }

        if ($args['type'] === 'rowadd') {
            $result = $db->QueryPrepare($table, "INSERT INTO TABLE (`ID`) VALUES (NULL)");
            if ($result !== false) {
                $logs = GetRows($db, $table, 0, $rowsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
                $status['maxPage'] = ceil($db->GetTableLength($table) / $rowsCount);
            } else {
                // TODO - Manage this error $db->GetLastError();
            }
        }

        if ($args['type'] === 'rowremove') {
            $result = $db->QueryPrepare($table, "DELETE FROM TABLE WHERE `ID` = ?", 'i', array($args['ID']));
            if ($result !== false) {
                $logStarts = ($args['page'] - 1) * $rowsCount;
                $logs = GetRows($db, $table, $logStarts, $rowsCount);
                $maxPage = ceil($db->GetTableLength($table) / $rowsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
                $status['maxPage'] = $maxPage;
            }
        }

        if ($args['type'] === 'navigation') {
            $logStarts = ($args['page'] - 1) * $rowsCount;
            $logs = GetRows($db, $table, $logStarts, $rowsCount);
            $maxPage = ceil($db->GetTableLength($table) / $rowsCount);

            $status['status'] = 'ok';
            $status['newPage'] = $args['page'];
            $status['maxPage'] = $maxPage;
            $status['content'] = TbodyFromDB($logs);
        }

        return $status;
    }

?>