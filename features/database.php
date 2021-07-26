<?php

    $db = new DataBase;

    function AddDataTable($table_name, $db_name) {
        global $db;

        $header = $db->query("SHOW COLUMNS FROM `$db_name`");
        $users = $db->query("SELECT * FROM `$db_name`");
    
        $fields = [];
        $table_header = "";
        while ($h = $header->fetch_assoc()) {
            $field = $h['Field'];
            $table_header .= "<th>$field</th>";
            $fields[] = $field;
        }
    
        $table_users = "";
        while ($u = $users->fetch_assoc()) {
            $table_users .= "<tr>";
            for ($i = 0; $i < count($fields); $i++) {
                $content = $u[$fields[$i]];
                $table_users .= "<td title='$content'>$content</td>";
            }
            $table_users .= "</tr>";
        }

        return "<div class='row'>
                    <div class='col-12'>
                        <div class='card'>
                            <div class='card-header'>
                                <h3 class='card-title'>$table_name</h3>
                            </div>

                            <div class='card-body table-responsive p-0'>
                                <table class='table table-hover text-nowrap'>
                                    <thead><tr>$table_header</tr></thead>
                                    <tbody>$table_users</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>";
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