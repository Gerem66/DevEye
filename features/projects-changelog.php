<?php

    require("dist/php/projects.php");

    $PID = GetPostValue('PID', 'NEW');
    $db = new DataBase;

    $name = $db->GetCellContent('Projects', 'Name', $PID, false);
    $content = $db->GetCellContent('Projects', 'Content', $PID);

?>
<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text"><?= $name ?>
                        <button type="submit" class="btn btn-success btn-sm col-2 fbtn">Sauvegarder</button>
                        <!--button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('projects-changelog', {'PID': '<?= $PID ?>'})">Changelog</button-->
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('projects-kanban', {'PID': '<?= $PID ?>'})">Retour</button>
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('projects-changelog', {'PID': '<?= $PID ?>'})">[Refresh]</button>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item"><a onclick="LoadPage('projects');">Projects</a></li>
                        <li class="breadcrumb-item active">Changelog</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">

            <h1>DU CALME, cette page n'est pas encore DEV !!!!</h1>

        </div>
    </div>
</div>