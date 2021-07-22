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

    // Save : Box moved
    if (isset($_POST['BID'])) {
        $bid = $_POST['BID'];       // Initial position (No) of the box
        $col = $_POST['column'];    // New column of the box
        $row = $_POST['row'];       // New row of the box
        if ($PID != 'NEW' && isset($col, $row)) {

            $curr_box_lines == NULL;
            $curr_box_index = 0;
            $split_content = explode("---", $content);
            // Each column
            for ($i = 0; $i < 4; $i++) {
                $blocks = explode("#", $split_content[$i]);
                // Each block
                if ($blocks[0] != "") {
                    for ($b = 0; $b < count($blocks); $b++) {
                        if ($curr_box_index == $bid) {
                            // Get this box
                            $curr_box_lines = array_splice($blocks, $b, 1)[0];
                            $split_content[$i] = join("#", $blocks);
                            break;
                        }
                        $curr_box_index += 1;
                    }
                }
                if ($curr_box_lines !== NULL) {
                    break;
                }
            }
            if ($curr_box_lines !== NULL) {
                // Add new box
                $kb_col = $split_content[$col];
                $kb_blocks = explode("#", $kb_col);
                if ($kb_blocks[0] == "") {
                    $split_content[$col] = $curr_box_lines;
                } else {
                    if ($row < 0 || $row == count($kb_blocks)) {
                        array_push($kb_blocks, $curr_box_lines);
                    } else {
                        array_splice($kb_blocks, $row, 0, $curr_box_lines);
                    }
                    $split_content[$col] = join("#", $kb_blocks);
                }
                $content = join("---", $split_content);
                $db->SaveCellContent('Projects', 'Content', $PID, $content);
            }
        }
    }

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

    // Get box content
    if (isset($_POST['get_box'])) {
        $bid = $_POST['get_box'];
        $curr_box_lines == NULL;
        $curr_box_index = 0;
        $split_content = explode("---", $content);
        // Each column
        for ($i = 0; $i < 4; $i++) {
            if ($curr_box_lines !== NULL) break;
            $blocks = explode("#", $split_content[$i]);
            // Each block
            if ($blocks[0] != "") {
                for ($b = 0; $b < count($blocks); $b++) {
                    if ($curr_box_index == $bid) {
                        // Get this box
                        $curr_box_lines = array_splice($blocks, $b, 1)[0];
                        $split_content[$i] = join("#", $blocks);
                        break;
                    }
                    $curr_box_index += 1;
                }
            }
        }
        echo($curr_box_lines);
        exit();
    }

    // Save box content
    if (isset($_POST['set_box'])) {
        $bid = $_POST['set_box'];
        if ($bid >= 0) {
            $box_content = $_POST['content'];
            $curr_box_index = 0;
            $split_content = explode("---", $content);
            $saved = false;
            // Each column
            for ($i = 0; $i < 4; $i++) {
                if ($saved) break;
                $blocks = explode("#", $split_content[$i]);
                // Each block
                if ($blocks[0] != "") {
                    for ($b = 0; $b < count($blocks); $b++) {
                        if ($curr_box_index == $bid) {
                            // Get this box
                            $blocks[$b] = $box_content;
                            $split_content[$i] = join("#", $blocks);
                            $saved = true;
                            break;
                        }
                        $curr_box_index += 1;
                    }
                }
            }
            if ($saved) {
                $content = join("---", $split_content);
                $db->SaveCellContent('Projects', 'Content', $PID, $content);
            }
        }
    }

    // Reset test content
    if (0) {
        $content = "3	Create Labels	info\n[] Bug\n[] Features\n[] Enhancement\n[] Documentation\n[] Examples#4	Create Issue Template	primary\n[] Bug Report\n[] Feature Request#6	Create PR template	primary#7	Create Actions	light\nLorem ipsum dolor sit amet, consectetuer adipiscing elit. Aenean commodo ligula eget dolor. Aenean massa. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus.---5	Create first milestone	primary---2	Update Readme	danger\nLorem ipsum dolor sit amet, consectetuer adipiscing elit. Aenean commodo ligula eget dolor. Aenean massa. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus.---1	Create repo	primary";
        $db->SaveCellContent('Projects', 'Content', $PID, $content);
    }

    //print_r($content);
    $kb = new KanBan($PID, $content);

?>

<input id="PID" value="<?= $PID ?>" style="display: none;">

<section id="popup-edit-box" class="kb-popup content-wrapper">
    <div class="popup-card">
        <h1 id="box-title">Édition</h1>
        <input id="box-name" class="form-control" type="text" placeholder="Boxname" value="">
        <select id="box-color" class="form-control" style="display: inline; width: 30%; margin: 1rem;">
            <option selected="" disabled="">Sélectionnez une couleur</option>
            <option class="bg-primary" value="primary">Bleu</option>
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
        <div class="col-8 card-center">
            <textarea id="box-body" class="form-control" style="min-height: 180px; max-height: 500px"></textarea>
        </div>

        <br />

        <button name="back" class="btn btn-dark btn-lg" style="margin-top: 24px;">
            Retour
        </button>
        <button name="save" class="btn bg-primary btn-lg" style="margin-top: 24px;">
            Enregistrer
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