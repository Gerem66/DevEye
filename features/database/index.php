<?php

    //$curr = 'database-dev-gl';
    //$credentials = [ 'localhost', 'u444572210_GameLifeDev', 'u444572210_GLAdminDev', 'T5*JSh;d' ];

    /** @var DataBase $db */

    /**
     * @param DataBase $db
     * @param string $table
     * @param int $page
     * @param int $pageLength
     */
    function AddDataTable($db, $table, $page, $pageLength) {
        $headers = GetHeaders($db, $table);
        $rows = GetRows($db, $table, $page, $pageLength);
        $lastPage = ceil(GetTableLength($db, $table) / $pageLength);

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

    $rowsCount = 10;

    if (isset($post['type'])) {
        DBTableCommand($db, $post, $rowsCount);
    }

    $tables = $db->GetTables();
    $tablesContent = '';
    foreach ($tables as $table) {
        $tablesContent .= AddDataTable($db, $table, 0, $rowsCount);
    }

    $variables = array(
        'username' => $user->Username,
        'tablesContent' => $tablesContent
    );
    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>