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

?>