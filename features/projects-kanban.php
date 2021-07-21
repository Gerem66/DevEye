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

<section id="popup-edit-box" class="kb-popup content-wrapper">
    <div class="popup-card">
        <h1 id="popup-title-create">Édition</h1>
        <input name="tb_id" type="hidden" class="form-control" value="<?= $accounts_length ?>" readonly>
        <input name="tb_title" type="text" class="form-control" placeholder="Nom du mail" value="">

        <div style="display: inline-flex; width: 30%; margin: 1rem;">
            <div class="input-group">
                <input name="tb_server" type="text" class="form-control" placeholder="Serveur" value="">
                <div class="input-group-prepend">
                    <button type="button" class="btn bg-<?= $main_color ?> dropdown-toggle" data-toggle="dropdown" aria-expanded="false" style="border-top-right-radius: 0.25rem; border-bottom-right-radius: 0.25rem;"></button>
                    <ul class="dropdown-menu" style="">
                        <li class="dropdown-item" onclick="SetServer(1, '{imap.gmail.com:993/imap/ssl/novalidate-cert}');">Google</li>
                        <li class="dropdown-item" onclick="SetServer(1, '{imap.mail.me.com:993/imap/ssl/novalidate-cert}');">iCloud</li>
                        <li class="dropdown-item" onclick="SetServer(1, '{imap.outlook.office365.com:993/imap/ssl/novalidate-cert}');">Outlook</li>
                        <li class="dropdown-item" onclick="SetServer(1, '{imap.mail.yahoo.com:993/imap/ssl/novalidate-cert}');">Yahoo</li>
                        <li class="dropdown-divider"></li>
                        <li class="dropdown-item" onclick="SetServer(1);">Clear</li>
                    </ul>
                </div>
            </div>
        </div>
        
        <input name="tb_mail" type="email" class="form-control" placeholder="Adresse Mail" value="">

        <div style="display: inline-flex; width: 30%; margin: 1rem;">
            <div class="input-group">
                <input name="tb_password" type="password" class="form-control" placeholder="Mot de passe" value="">
                <div class="input-group-prepend">
                    <button type="button" class="btn bg-<?= $main_color ?>" onclick="SwitchPasswordVision(this);" style="border-top-right-radius: 0.25rem; border-bottom-right-radius: 0.25rem; padding: 0; width: 34px"><i class="far fa-eye-slash"></i></button>
                </div>
            </div>
        </div>

        <select name="tb_color" class="form-control custom-select" style="display: inline; width: 30%; margin: 1rem;">
            <option selected="" disabled="">Sélectionnez une couleur</option>
            <option class="bg-primary" value="primary" selected>Bleu</option>
            <option class="bg-secondary" value="secondary">Gris</option>
            <option class="bg-success" value="success">Vert</option>
            <option class="bg-info" value="info">Turquoise</option>
            <option class="bg-danger" value="danger">Rouge</option>
            <option class="bg-indigo" value="indigo">Indigo</option>
            <option class="bg-navy" value="navy">Bleu Marine</option>
            <option class="bg-lightblue" value="lightblue">Bleu clair</option>
            <option class="bg-teal" value="teal">Vert Clair</option>
            <option class="bg-cyan" value="cyan">Cyan</option>
            <option class="bg-yellow" value="yellow">Jaune</option>
            <option class="bg-orange" value="orange">Orange</option>
            <option class="bg-light" value="light">Blanc</option>
        </select>
        <br />
        <button name="back" class="btn btn-dark btn-lg" style="margin-top: 24px;">
            Retour
        </button>
        <button name="save" class="btn bg-primary btn-lg" style="margin-top: 24px;">
            Ajouter
        </button>
    </div>
</section>

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
        <div id="parent" class="container-fluid h-100">


            <div name="column" class="card card-row card-secondary">
                <div class="card-header">
                    <h3 class="card-title">Backlog</h3>
                </div>
                <div class="card-body">
                    <?= $kb->columns['BACKLOG'] ?>
                </div>
            </div>

            <div name="column" class="card card-row card-primary">
                <div class="card-header">
                    <h3 class="card-title">A faire</h3>
                </div>
                <div class="card-body">
                    <?= $kb->columns['TODO'] ?>
                </div>
            </div>

            <div name="column" class="card card-row card-default">
                <div class="card-header bg-info">
                    <h3 class="card-title">En cours</h3>
                </div>
                <div class="card-body">
                    <?= $kb->columns['INPROGRESS'] ?>
                </div>
            </div>

            <div name="column" class="card card-row card-success">
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