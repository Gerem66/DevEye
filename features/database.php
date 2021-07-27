<?php

    $db = new DataBase;

    function AddDataTable($table_name, $db_name) {
        global $db;

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
            $table_content .= "<td><i name='trash' class='fas fa-trash a' idcell='$id' table='$db_name'></i></td>";

            for ($i = 0; $i < count($fields); $i++) {
                $col = $fields[$i];
                $content = $u[$col];
                $content_specialchars = str_replace("\n", "\\n", $content);
                $table_content .= "<td name='cell' title='$content' idcell='$id' column='$col' dbname='$db_name'>$content_specialchars</td>";
            }
            $table_content .= "</tr>";
        }

        return "<div class='row'>
                    <div class='col-12'>
                        <div class='card'>
                            <div class='card-header'>
                                <h3 class='card-title'>$table_name</h3>
                                <div class='card-tools'>
                                    <a class='btn btn-tool a' onclick=\"LoadPage('database', {'add': '$db_name'});\">
                                        <i class='fas fa-plus'></i>
                                    </a>
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
        $db->query("INSERT INTO `u444572210_oxy`.`$addName` (`ID`) VALUES (DEFAULT)");
    }

    if (isset($_POST['edit'])) {
        $editID = $_POST['edit'];
        $column = $_POST['column'];
        $table = $_POST['table'];
        $content = str_replace("'", "\'", $_POST['content']);
        if (isset($editID, $table)) {
            $db->query("UPDATE `u444572210_oxy`.`$table` SET `$column` = '$content' WHERE ID = '$editID'");
        }
    }

    if (isset($_POST['rem'])) {
        $remID = $_POST['rem'];
        $table = $_POST['table'];
        if (isset($remID, $table)) {
            $db->query("DELETE FROM `u444572210_oxy`.`$table` WHERE `ID` = '$remID'");
        }
    }

    $tables = AddDataTable("Utilisateurs", "Users");
    $tables .= AddDataTable("Instances", "Instances");
    $tables .= AddDataTable("Projets", "Projects");

?>

<style>
    tbody td {
        max-width: 256px;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    tbody td input {
        min-width: calc(256px - 12px);
    }
    tbody td i {
        transition: color 0.25s ease 0s;
    }
    tbody td i.red {
        color: red;
    }
</style>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Base de données</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">database</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">

            <?= $tables ?>

        </div>
    </div>
</div>