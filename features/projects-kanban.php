<?php

    require("dist/php/projects.php");

    $UID = $_SESSION['ID'];
    $IID = $_SESSION['INSTANCE_ID'];
    $PID = GetPostValue('PID', 'NEW');
    $projects = $_SESSION['PROJECTS'];

    if (isset($_POST['save'])) {
        $Name = $_POST['Name'];
        $Date = $_POST['Date'];
        $Type = $_POST['Type'];
        $Progress = $_POST['Progress'];
        $InstanceMode = $_POST['InstanceMode'];
        $Status = $_POST['Status'];
        $Color = $_POST['Color'];
        $Description = $_POST['Description'];
        if ($PID == 'NEW') {
            // Add new project in bdd & get new ID
            $q = "INSERT INTO `u444572210_oxy`.`Projects`
                (`UserID`, `InstanceID`, `Name`,  `Date`,  `Type`,  `Progress`,  `InstanceMode`,  `Status`,  `Color`,  `Description`) VALUES
                ('$UID',   '$IID',       '$Name', '$Date', '$Type', '$Progress', '$InstanceMode', '$Status', '$Color', '$Description')";

            $conn = OpenConnection();
            if ($conn->query($q) === TRUE) {
                $PID = $conn->insert_id;
            }
            $conn->close();
        } else {
            // Update project (save all data)
            $q = "UPDATE `u444572210_oxy`.`Projects` SET
                `UserID`='$UID',
                `InstanceID`='$IID',
                `Name`='$Name',
                `Date`='$Date',
                `Type`='$Type',
                `Progress`='$Progress',
                `InstanceMode`='$InstanceMode',
                `Status`='$Status',
                `Color`='$Color',
                `Description`='$Description' WHERE `ID` = '$PID'";

            $conn = OpenConnection();
            if ($conn->query($q) === TRUE) {
                // C'est ok je crois, et penser à gérer les erreurs (redirection ?)
            }
            $conn->close();
        }
    }

    $content = GetRowContent('Projects', 'ID', $PID);
    // Interpréter le content puis l'afficher

?>

<div class="content-wrapper kanban">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Kanban (<?= $PID ?>)
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('projects-edit', {'PID': '<?= $PID ?>'})">Éditer le projet</button>
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('projects-kanban', {'PID': '<?= $PID ?>'})">[Refresh]</button>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item"><a onclick="LoadPage('projects');">Projects</a></li>
                        <li class="breadcrumb-item active">Kanban</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content pb-3">
        <div class="container-fluid h-100">
            <!-- Main content -->

            <div class="card card-row card-secondary">
                <div class="card-header">
                    <h3 class="card-title">Backlog</h3>
                </div>
                <div class="card-body">
                    <div class="card card-info card-outline">
                        <div class="card-header">
                            <h5 class="card-title">Create Labels</h5>
                            <div class="card-tools">
                            <a href="#" class="btn btn-tool btn-link">#3</a>
                            <a href="#" class="btn btn-tool">
                                <i class="fas fa-pen"></i>
                            </a>
                            </div>
                        </div>
                        <div class="card-body">
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox1" disabled="">
                                <label for="customCheckbox1" class="custom-control-label">Bug</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox2" disabled="">
                                <label for="customCheckbox2" class="custom-control-label">Feature</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox3" disabled="">
                                <label for="customCheckbox3" class="custom-control-label">Enhancement</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox4" disabled="">
                                <label for="customCheckbox4" class="custom-control-label">Documentation</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox5" disabled="">
                                <label for="customCheckbox5" class="custom-control-label">Examples</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox5" disabled="">
                                <label for="customCheckbox5" class="custom-control-label">Examples</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox5" disabled="">
                                <label for="customCheckbox5" class="custom-control-label">Examples</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                                <input class="custom-control-input" type="checkbox" id="customCheckbox5" disabled="">
                                <label for="customCheckbox5" class="custom-control-label">Examples</label>
                            </div>
                        </div>
                    </div>
                    <div class="card card-primary card-outline">
                        <div class="card-header">
                            <h5 class="card-title">Create Issue template</h5>
                            <div class="card-tools">
                            <a href="#" class="btn btn-tool btn-link">#4</a>
                            <a href="#" class="btn btn-tool">
                                <i class="fas fa-pen"></i>
                            </a>
                            </div>
                        </div>
                        <div class="card-body">
                            <div class="custom-control custom-checkbox">
                            <input class="custom-control-input" type="checkbox" id="customCheckbox1_1" disabled="">
                            <label for="customCheckbox1_1" class="custom-control-label">Bug Report</label>
                            </div>
                            <div class="custom-control custom-checkbox">
                            <input class="custom-control-input" type="checkbox" id="customCheckbox1_2" disabled="">
                            <label for="customCheckbox1_2" class="custom-control-label">Feature Request</label>
                            </div>
                        </div>
                    </div>
                    <div class="card card-primary card-outline">
                        <div class="card-header">
                            <h5 class="card-title">Create PR template</h5>
                            <div class="card-tools">
                            <a href="#" class="btn btn-tool btn-link">#6</a>
                            <a href="#" class="btn btn-tool">
                                <i class="fas fa-pen"></i>
                            </a>
                            </div>
                        </div>
                    </div>
                    <div class="card card-light card-outline">
                        <div class="card-header">
                            <h5 class="card-title">Create Actions</h5>
                            <div class="card-tools">
                            <a href="#" class="btn btn-tool btn-link">#7</a>
                            <a href="#" class="btn btn-tool">
                                <i class="fas fa-pen"></i>
                            </a>
                            </div>
                        </div>
                        <div class="card-body">
                            <p>
                            Lorem ipsum dolor sit amet, consectetuer adipiscing elit.
                            Aenean commodo ligula eget dolor. Aenean massa.
                            Cum sociis natoque penatibus et magnis dis parturient montes,
                            nascetur ridiculus mus.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card card-row card-primary">
                <div class="card-header">
                    <h3 class="card-title">A faire</h3>
                </div>
                <div class="card-body">
                    <div class="card card-primary card-outline">
                        <div class="card-header">
                            <h5 class="card-title">Create first milestone</h5>
                            <div class="card-tools">
                            <a href="#" class="btn btn-tool btn-link">#5</a>
                            <a href="#" class="btn btn-tool">
                                <i class="fas fa-pen"></i>
                            </a>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card card-row card-default">
                <div class="card-header bg-info">
                    <h3 class="card-title">En cours</h3>
                </div>
                <div class="card-body">
                    <div class="card card-light card-outline">
                        <div class="card-header">
                            <h5 class="card-title">Update Readme</h5>
                            <div class="card-tools">
                            <a href="#" class="btn btn-tool btn-link">#2</a>
                            <a href="#" class="btn btn-tool">
                                <i class="fas fa-pen"></i>
                            </a>
                            </div>
                        </div>
                        <div class="card-body">
                            <p>
                            Lorem ipsum dolor sit amet, consectetuer adipiscing elit.
                            Aenean commodo ligula eget dolor. Aenean massa.
                            Cum sociis natoque penatibus et magnis dis parturient montes,
                            nascetur ridiculus mus.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card card-row card-success">
                <div class="card-header">
                    <h3 class="card-title">Terminé</h3>
                </div>
                <div class="card-body">
                    <div class="card card-primary card-outline">
                        <div class="card-header">
                            <h5 class="card-title">Create repo</h5>
                            <div class="card-tools">
                            <a href="#" class="btn btn-tool btn-link">#1</a>
                            <a href="#" class="btn btn-tool">
                                <i class="fas fa-pen"></i>
                            </a>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

    </div>
</div>