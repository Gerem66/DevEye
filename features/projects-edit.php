<?php

    $projectID = GetPostValue('PID', 'NEW');
    $isNew = $projectID == 'NEW';

    // Define all types
    $types = [ 'Logiciel (PC)', 'Algorithme (Console)', 'Embarqué', 'Application mobile', 'Site Web', 'Embarqué', 'Jeux Vidéo' ];
    $status = [ 'Pas commencé', 'En attente', 'En cours', 'Phase de test', 'Alpha', 'Beta', 'Terminé' ];
    $colors = array("primary" => "Bleu", "secondary" => "Gris", "success" => "Vert",
                    "info" => "Turquoise", "danger" => "Rouge", "indigo" => "Indigo",
                    "navy" => "Bleu Marine", "lightblue" => "Bleu clair", "teal" => "Vert Clair",
                    "cyan" => "Cyan", "yellow" => "Jaune", "orange" => "Orange", "light" => "Blanc");

    // Define project vars
    if ($isNew) {
        $PID         = 'NEW';
        $name        = '';
        $date        = '';
        $type        = '';
        $prog        = '0';
        $inst        = false;
        $stat        = '';
        $color       = '';
        $link        = '';
        $description = '';
    } else {
        $db = new DataBase;
        $project = $db->GetRowContent('Projects', 'ID', $projectID);
        $PID         = $projectID;
        $name        = $project['Name'];
        $date        = $project['Date'];
        $type        = $project['Type'];
        $prog        = $project['Progress'];
        $inst        = $project['InstanceMode'];
        $stat        = $project['Status'];
        $color       = $project['Color'];
        $link        = $project['Link'];
        $description = $project['Description'];
    }

    $title_txt = $isNew ? "Création d'un nouveau projet" : $name;
    $page_txt = $isNew ? 'New' : 'Edit';

    // Define content
    $types_content = "";
    $status_content = "";
    $colors_content = "";
    for ($i = 0; $i < count($types); $i++) {
        $t = $types[$i];
        $selected = $t == $type ? ' selected' : '';
        $types_content .= "<option$selected>$t</option>";
    }
    for ($i = 0; $i < count($status); $i++) {
        $s = $status[$i];
        $selected = $s == $stat ? ' selected' : '';
        $status_content .= "<option$selected>$s</option>";
    }
    foreach ($colors as $key => $value) {
        $selected = $key == $color ? ' selected' : '';
        $colors_content .= "<option class='bg-$key' value='$key'$selected>$value</option>";
    }

?>

<input id="PID" value="<?= $PID ?>" style="display: none;">

<form method="POST" autocomplete="off" class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text"><?= $title_txt ?>
                        <div class="btn-group col-4" style="margin-left: 48px">
                            <button id="bt-back" type="button" class="btn btn-primary btn-sm col-2 fbtn">Retour</button>
                            <button type="submit" class="btn btn-success btn-sm col-8 fbtn">Sauvegarder</button>
                        </div>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item"><a onclick="LoadPage('projects');">Projects</a></li>
                        <li class="breadcrumb-item active"><?= $page_txt ?></li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">


                <div class="row">
                    <div class="col-md-6 card-center">
                        <div class="card card-primary">
                            <div class="card-header">
                                <h3 class="card-title">Informations du projet</h3>
                                <button id="bt-rem-project" type="button" class="btn btn-danger btn-sm col-3 fbtn float-right">Supprimer le projet</button>
                            </div>
                            <div class="card-body">

                                <div class="row">
                                    <div class="form-group col-2">
                                        <!-- ID -->
                                        <label for="projectID">ID</label>
                                        <input type="text" id="projectID" class="form-control" value="<?= $PID ?>" readonly>
                                    </div>
                                    <div class="form-group col-7">
                                        <!-- Project Name -->
                                        <label for="projectName">Nom du projet</label>
                                        <input type="text" id="projectName" class="form-control" value="<?= $name ?>" required>
                                    </div>
                                    <div class="form-group col-3">
                                        <!-- Start Date -->
                                        <label for="inputDate">Date de commencement</label>
                                        <div class="input-group">
                                            <input id="inputDate" type="date" class="form-control" value="<?= $date ?>" required>
                                            <div class="input-group-prepend">
                                                <label for="inputDate" class="input-group-text" style="border-bottom-right-radius: 4px; border-top-right-radius: 4px;">
                                                    <i class="far fa-calendar-alt"></i>
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- Project Type -->
                                <div class="row">
                                    <div class="form-group col-6">
                                        <label for="inputType">Type de projet</label>
                                        <select id="inputType" class="form-control custom-select" selected="Embarqué" required>
                                            <option disabled>Sélectionnez un type de projet</option>
                                            <?= $types_content ?>
                                        </select>
                                    </div>
                                    <!-- Progress -->
                                    <div class="form-group col-3">
                                        <label for="inputProgress">Progression</label>
                                        <input id="inputProgress" type="number" class="form-control" value="<?= $prog ?>" step="1" min="0" max="100" required>
                                    </div>
                                    <!-- Instance mode -->
                                    <div class="form-group col-3 flex-center">
                                        <div class="form-check" style="margin-top: 2rem;">
                                            <input type="checkbox" class="form-check-input" id="inputInstance" <?= $inst ? 'checked' : '' ?>>
                                            <label class="form-check-label" for="inputInstance">Mode Instance</label>
                                        </div>
                                    </div>
                                </div>

                                <div class="row">
                                    <div class="form-group col-3">
                                        <!-- Status -->
                                        <label for="inputStatus">Statut</label>
                                        <select id="inputStatus" class="form-control custom-select" required>
                                            <option disabled>Sélectionnez un statut</option>
                                            <?= $status_content ?>
                                        </select>
                                    </div>
                                    <div class="form-group col-3">
                                        <!-- Color Status -->
                                        <label for="inputColorStatus">Couleur du statut</label>
                                        <select id="inputColorStatus" class="form-control custom-select" required>
                                            <option disabled>Sélectionnez une couleur</option>
                                            <?= $colors_content ?>
                                        </select>
                                    </div>
                                    <div class="form-group col-6">
                                        <!-- Project Name -->
                                        <label for="inputLink">Lien github</label>
                                        <input type="text" id="inputLink" class="form-control" value="<?= $link ?>">
                                    </div>
                                </div>

                                <!-- Description -->
                                <label for="inputDescription">Description du projet</label>
                                <textarea id="inputDescription" class="form-control" rows="8"><?= $description ?></textarea>
                            </div>
                        </div>
                    </div>
                </div>


        </div>
    </div>
</form>