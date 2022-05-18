<?php

    /**
     * @param DataBase $db
     * @param string $table
     * @param int $starts
     * @param int $count
     */
    function GetRows($db, $table, $starts, $count) {
        return $db->QueryArray("SELECT * FROM `$table` ORDER BY `ID` DESC LIMIT $count OFFSET $starts");
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

    function ExecCommand($db, $post, $logsCount = 10) {
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
                $logs = GetRows($db, $post['table'], 0, $logsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
            }
        }

        if ($post['type'] === 'rowremove') {
            $result = $db->Query("DELETE FROM `{$post['table']}` WHERE `ID` = {$post['ID']}");
            $status['status'] = 'error';
            if ($result !== false) {
                $logStarts = ($post['page'] - 1) * $logsCount;
                $logs = GetRows($db, $post['table'], $logStarts, $logsCount);
                $status['status'] = 'ok';
                $status['content'] = TbodyFromDB($logs);
            }
        }

        if ($post['type'] === 'navigation') {
            $logStarts = ($post['page'] - 1) * $logsCount;
            $logs = GetRows($db, $post['table'], $logStarts, $logsCount);

            $logsIDs = $db->QueryArray("SELECT `ID` FROM `Logs`");
            $logsLength = count($logsIDs);
            $maxPage = ceil($logsLength / $logsCount);

            $status['status'] = 'ok';
            $status['newPage'] = $post['page'];
            $status['maxPage'] = $maxPage;
            $status['content'] = TbodyFromDB($logs);
        }

        echo(json_encode($status));
        exit();
    }

?>