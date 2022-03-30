<?php

    $cellIndex = 0;
    function AddDataTable($table_name, $db_name) {
        global $db, $cellIndex, $curr;

        $header = $db->query("SHOW COLUMNS FROM `$db_name`");
        $users = $db->query("SELECT * FROM `$db_name`");
    
        $fields = [];
        $table_header = "<th></th>";
        while ($h = $header->fetch_assoc()) {
            $field = $h['Field'];
            $table_header .= "<th>$field</th>";
            $fields[] = $field;
        }

        $table_content = "";
        while ($u = $users->fetch_assoc()) {
            $table_content .= "<tr>";
            // Add Trash
            $id = $u['ID'];
            $table_content .= "<td tabindex='$cellIndex'><i name='trash' class='fas fa-trash a' idcell='$id' table='$db_name'></i></td>";
            $cellIndex += 1;
            
            for ($i = 0; $i < count($fields); $i++) {
                $col = $fields[$i];
                $content = $u[$col];
                $content_specialchars = str_replace("\n", "\\n", $content);
                $table_content .= "<td tabindex='$cellIndex' name='cell' title='$content' idcell='$id' column='$col' dbname='$db_name'>$content_specialchars</td>";
                $cellIndex += 1;
            }
            $table_content .= "</tr>";
        }

        return "<div class='row'>
                    <div class='col-12'>
                        <div class='card collapsed-card'>
                            <div class='card-header'>
                                <h3 class='card-title'>$table_name</h3>
                                <div class='card-tools'>
                                    <a class='btn btn-tool a' onclick=\"LoadPage('$curr', {'add': '$db_name'});\">
                                        Add
                                    </a>
                                    <button type='button' class='btn btn-tool' data-card-widget='collapse'>
                                        <i class='fas fa-plus'></i>
                                    </button>
                                </div>
                            </div>

                            <div class='card-body table-responsive p-0'>
                                <table class='table table-hover text-nowrap'>
                                    <thead><tr>$table_header</tr></thead>
                                    <tbody>$table_content</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>";
    }

    if (isset($_POST['add'])) {
        $addName = $_POST['add'];
        $db->query("INSERT INTO `$addName` (`ID`) VALUES (DEFAULT)");
    }

    if (isset($_POST['edit'])) {
        $editID = $_POST['edit'];
        $column = $_POST['column'];
        $table = $_POST['table'];
        $content = str_replace("'", "\'", $_POST['content']);
        if (isset($editID, $table)) {
            $db->query("UPDATE `$table` SET `$column` = '$content' WHERE ID = '$editID'");
        }
    }

    if (isset($_POST['rem'])) {
        $remID = $_POST['rem'];
        $table = $_POST['table'];
        if (isset($remID, $table)) {
            $db->query("DELETE FROM `$table` WHERE `ID` = '$remID'");
        }
    }

?>