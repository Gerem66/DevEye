<?php

    $curr = 'database-gl';
    $credentials = [ 'localhost', 'u444572210_GameLife', 'u444572210_GLAdmin', '2>Siz^BDOeoT5*JSh;d' ];
    $db = new DataBase(true, $credentials);

    require('dist/php/database.php');

    //$tables = AddDataTable("Users", "Users");
    $tables = AddDataTable("Report", "Reports");
    $tables .= AddDataTable("Achievements", "Achievements");
    $tables .= AddDataTable("Titles", "Titles");
    $tables .= AddDataTable("Categories", "Categories");
    $tables .= AddDataTable("Skills", "Skills");
    $tables .= AddDataTable("SkillsIcon", "SkillsIcon");
    $tables .= AddDataTable("Quotes", "Quotes");
    $tables .= AddDataTable("Contributors", "Contributors");
    //$tables .= AddDataTable("Devices", "Devices");*/

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
                    <h1 class="m-0 text">Base de données - Game Life</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">database-gl</li>
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