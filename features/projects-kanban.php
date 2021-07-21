<?php

    require("dist/php/projects.php");

    $UID = $_SESSION['ID'];
    $IID = $_SESSION['INSTANCE_ID'];
    $PID = GetPostValue('PID', 'NEW');
    //$projects = $_SESSION['PROJECTS'];
    $db = new DataBase;

    // Save : Settings project (name, date, color, collab, etc)
    if (isset($_POST['save'])) {
        $Name = $_POST['Name'];
        $Date = $_POST['Date'];
        $Type = $_POST['Type'];
        $Progress = $_POST['Progress'];
        $InstanceMode = $_POST['InstanceMode'];
        $Status = $_POST['Status'];
        $Color = $_POST['Color'];
        $Description = $_POST['Description'];

        if (isset($Name, $Date, $Type, $Progress, $InstanceMode, $Status, $Color, $Description)) {
            if ($PID == 'NEW') {
                // Add new project in bdd & get new ID
                $q = "INSERT INTO `u444572210_oxy`.`Projects`
                    (`UserID`, `InstanceID`, `Name`,  `Date`,  `Type`,  `Progress`,  `InstanceMode`,  `Status`,  `Color`,  `Description`) VALUES
                    ('$UID',   '$IID',       '$Name', '$Date', '$Type', '$Progress', '$InstanceMode', '$Status', '$Color', '$Description')";

                if ($db->query($q) === TRUE) {
                    $PID = $conn->insert_id;
                }
            } else if (intval($PID) > 0) {
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
            }
        }
    }

    $content = $db->GetCellContent('Projects', 'Content', $PID);

    // Save : Switch square
    if (isset($_POST['square_toggle'])) {
        $square_id = $_POST['square_toggle'];
        $square_nb = 0;
        $lines = explode("\n", $content);
        for ($i = 0; $i < count($lines); $i++) {
            $pre = explode(' ', $lines[$i])[0];
            if (strlen($lines[$i]) >= strlen($pre) + 1)
                $l = substr($lines[$i], strlen($pre) + 1);

            if (strlen($pre) < 4 && $pre[0] == '[' && $pre[-1] == ']') {
                if ($square_nb == $square_id) {
                    if (strlen($pre) == 2) {
                        $lines[$i] = "[v] $l";
                        echo("OK");
                    }
                    else if (strlen($pre) == 3) {
                        $lines[$i] = "[] $l";
                        echo("OK");
                    }
                    break;
                }
                $square_nb += 1;
            }
        }
        $db->SaveCellContent('Projects', 'Content', $PID, join("\n", $lines));
        exit();
    }

    $kb = new KanBan($PID, $content);

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


            <div class="card card-row card-secondary">
                <div class="card-header">
                    <h3 class="card-title">Backlog</h3>
                </div>
                <div class="card-body">
                    <?= $kb->columns['BACKLOG'] ?>
                </div>
            </div>

            <div class="card card-row card-primary">
                <div class="card-header">
                    <h3 class="card-title">A faire</h3>
                </div>
                <div class="card-body">
                    <?= $kb->columns['TODO'] ?>
                </div>
            </div>

            <div class="card card-row card-default">
                <div class="card-header bg-info">
                    <h3 class="card-title">En cours</h3>
                </div>
                <div class="card-body">
                    <?= $kb->columns['INPROGRESS'] ?>
                </div>
            </div>

            <div class="card card-row card-success">
                <div class="card-header">
                    <h3 class="card-title">Terminé</h3>
                </div>
                <div class="card-body">
                    <?= $kb->columns['FINISHED'] ?>
                </div>
            </div>


        </div>
    </div>
</div>