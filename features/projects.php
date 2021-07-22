<?php

    require("dist/php/projects.php");

    $ID = $_SESSION['ID'];
    $IID = $_SESSION['INSTANCE_ID'];
    $projects = new Projects;
    $db = new DataBase;

    // Remove project
    if (isset($_POST['RemoveProject'])) {
        $pid = $_POST['RemoveProject'];
        $db->RemoveRow('Projects', $pid);
    }

    // /!\ User sans instance ?
    //$user_projects = $db->GetRowsContent('Projects', 'UserID', $_SESSION['ID']);

    $inst_projects = $db->GetRowsContent('Projects', 'InstanceID', $IID);
    $projects->AddProjectsFromDB($inst_projects);
    $projects->SortByDate();

    $_SESSION['PROJECTS'] = $projects;

    $projects_rows = $projects->AllProjectsToTable($ID);

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Projets
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('projects-edit')">Ajouter un projet</button>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">Projects</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">

            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Projects</h3>
                </div>
                <div class="card-body p-0">
                    <table class="table table-striped projects">
                        <thead>
                            <tr>
                                <th style="width: 3%">#</th>
                                <th style="width: 3%"></th>
                                <th style="width: 20%">Nom du projet</th>
                                <th style="width: 10%">Créateur</th>
                                <th>Progression</th>
                                <th style="width: 10%" class="text-center">Statut</th>
                                <!--th style="width: 10%"></th-->
                                <th style="width: 15%"></th>
                            </tr>
                        </thead>
                        <tbody>

                            <?= $projects_rows ?>

                        </tbody>
                    </table>
                </div>
            </div>

        </div>
    </div>

</div>