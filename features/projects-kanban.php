<?php

    require("dist/php/projects.php");
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    $UID = $_SESSION['ID'];
    $IID = $_SESSION['INSTANCE_ID'];
    $PID = GetPostValue('PID', 'NEW');
    $projects = unserialize($_SESSION['PROJECTS']);
    $project = null;
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
                $Name = str_replace("'", "\'", $Name);
                $project = $projects->CreateNewProject($db, $UID, $IID, $Name, $Date, $Type, $Progress, $InstanceMode, $Status, $Color, $Description);
                $PID = $project->id;
            } else if (intval($PID) > 0) {
                $project = $projects->GetProjectFromID($PID);
                $project->instanceMode = $InstanceMode;
                $project->name = $Name;
                $project->description = $Description;
                $project->type = $Type;
                $project->status = $Status;
                $project->progress = $Progress;
                $project->color = $Color;
                $project->date = $Date;
                if ($project->Save($db) === TRUE) {
                    // Success / Manage eventually errors
                }
            }
        }
    } else {
        $project = $projects->GetProjectFromID($PID);
    }

    // Save : Box moved
    if (isset($_POST['BID'])) {
        $bid = $_POST['BID'];       // Initial position (No) of the box
        $col = $_POST['column'];    // New column of the box
        $row = $_POST['row'];       // New row of the box
        if ($PID != 'NEW' && isset($col, $row)) {

            $curr_box_lines == NULL;
            $curr_box_index = 0;
            $split_content = explode("---", $project->content);
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
                $project->SaveContent($db, join("---", $split_content));
            }
        }
    }

    // Save : Switch square
    if (isset($_POST['square_toggle'])) {
        $result = "";
        $square_id = $_POST['square_toggle'];
        $square_nb = 0;

        $columns = explode("---", $project->content);
        for ($c = 0; $c < count($columns); $c++) {
            $blocks = explode("#", $columns[$c]);
            if ($blocks[0] != "") {
                for ($b = 0; $b < count($blocks); $b++) {
                    $split_block = explode("\t", $blocks[$b]);
                    $content = end($split_block);
                    $lines = explode("\n", $content);

                    for ($i = 0; $i < count($lines); $i++) {
                        $pre = explode(' ', $lines[$i])[0];
                        if (strlen($lines[$i]) >= strlen($pre) + 1) {
                            $l = substr($lines[$i], strlen($pre) + 1);
                        }

                        if (strlen($pre) < 4 && $pre[0] == '[' && $pre[-1] == ']') {
                            if ($square_nb == $square_id) {
                                if (strlen($pre) == 2) {
                                    $lines[$i] = "[v] $l";
                                    $result = "OK";
                                }
                                else if (strlen($pre) == 3) {
                                    $lines[$i] = "[] $l";
                                    $result = "OK";
                                }
                                break;
                            }
                            $square_nb += 1;
                        }
                    }

                    $content = join("\n", $lines);
                    $split_block[count($split_block) - 1] = $content;
                    $blocks[$b] = join("\t", $split_block);
                    if ($result !== "") break;
                }
                $columns[$c] = join("#", $blocks);
            }
        }

        $project->SaveContent($db, join("---", $columns));
        $_SESSION['PROJECTS'] = serialize($projects);
        echo($result);
        exit();
    }

    // Get box content
    if (isset($_POST['get_box'])) {
        $bid = $_POST['get_box'];
        $curr_box_lines == NULL;
        $curr_box_index = 0;
        $split_content = explode("---", $project->content);
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
            $split_content = explode("---", $project->content);
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
                $project->SaveContent($db, join("---", $split_content));
            }
        }
    }

    // Add new box
    if (isset($_POST['add_box'])) {
        $column = $_POST['add_box'];
        $split_content = explode("---", $project->content);

        // Get all id - kanban
        $ids = array();
        for ($i = 0; $i < count($split_content); $i++) {
            $blocks = explode("#", $split_content[$i]);
            if ($blocks[0] == "") continue;
            for ($b = 0; $b < count($blocks); $b++) {
                $id = explode("\t", $blocks[$b])[0];
                array_push($ids, $id);
            }
        }

        // Get all id - kanban
        $split_changelog = explode("#", $project->changelog);
        if ($split_changelog[0] != "") {
            for ($i = 0; $i < count($split_changelog); $i++) {
                $type = explode("\t", $split_changelog[$i])[0];
                if ($type === "B") {
                    $id = explode("\t", $split_changelog[$i])[1];
                    array_push($ids, $id);
                }
            }
        }

        // Define id
        $id = 1;
        while (array_search($id, $ids) !== false) {
            $id++;
        }


        $blocks = explode("#", $split_content[$column]);
        $newBox_raw = "$id\tNom par défaut\tprimary\t";
        if ($blocks[0] == "") $blocks[0] = $newBox_raw;
        else array_push($blocks, $newBox_raw);
        $split_content[$column] = join("#", $blocks);
        $project->SaveContent($db, join("---", $split_content));
    }

    // Remove box
    if (isset($_POST['rem_box'])) {
        $bid = $_POST['rem_box'];
        $curr_box_index = 0;
        $split_content = explode("---", $project->content);
        $removed = false;
        // Each column
        for ($i = 0; $i < 4; $i++) {
            if ($removed) break;
            $blocks = explode("#", $split_content[$i]);
            // Each block
            if ($blocks[0] != "") {
                for ($b = 0; $b < count($blocks); $b++) {
                    if ($curr_box_index == $bid) {
                        // Remove
                        array_splice($blocks, $b, 1);
                        $split_content[$i] = join("#", $blocks);
                        $removed = true;
                        break;
                    }
                    $curr_box_index += 1;
                }
            }
        }
        if ($removed) {
            $project->SaveContent($db, join("---", $split_content));
        }
    }

    // Archive
    if (isset($_POST['archive'])) {
        // Empty last column
        $split_content = explode("---", $project->content);

        if ($split_content[3] !== "") {
            $blocksToArchive = explode("#", $split_content[3]);
            $split_content[3] = "";
            $project->SaveContent($db, join("---", $split_content));

            // Add to changelog
            $currDate = strftime("%A %e, %B %Y"); // date('D j, Y');
            $currTime = strftime("%H:%M"); // date('H:i');
            $changelog = explode("#", $project->changelog);

            // Define index to add
            $id = 0;

            // Check if already currdate in changelog
            for ($c = 0; $c < count($changelog); $c++) {
                if (startsWith($changelog[$c], "T\t$currDate")) {
                    $id = $c+1;
                    break;
                }
            }

            function AddChangelog($content) {
                global $id, $changelog;
                array_splice($changelog, $id, 0, $content);
                $id++;
            }

            // Add to top
            if (!$id) AddChangelog("T\t$currDate\tsuccess");
            for ($b = 0; $b < count($blocksToArchive); $b++) {
                $_block = explode("\t", $blocksToArchive[$b]);
                array_splice($_block, 2, 0, $currTime);
                array_splice($_block, 2, 0, $_SESSION['USERNAME']);
                array_splice($_block, 2, 0, $_SESSION['PHOTO']);
                $newBlock = "B\t" . join("\t", $_block);
                AddChangelog($newBlock);
            }

            $project->SaveChangelog($db, join("#", $changelog));
        }
    }

    // Reset test content
    if (0) {
        $template_test = "3	Create Labels	info	[] Bug\n[] Features\n[] Enhancement\n[] Documentation\n[] Examples#4	Create Issue Template	primary	[] Bug Report\n[] Feature Request#6	Create PR template	primary	#7	Create Actions	light	Lorem ipsum dolor sit amet, consectetuer adipiscing elit. Aenean commodo ligula eget dolor. Aenean massa. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus.---5	Create first milestone	primary	---2	Update Readme	danger	Lorem ipsum dolor sit amet, consectetuer adipiscing elit. Aenean commodo ligula eget dolor. Aenean massa. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus.---1	Create repo	primary	";
        $project->SaveContent($db, $template_test);
    }

    $_SESSION['PROJECTS'] = serialize($projects);

    print_r($project->content);
    $kb = new KanBan($PID, $project->content);

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

        <div class="col-8 card-center">
            <button name="del" class="btn btn-danger btn-popup-sm float-left" style="margin-top: 24px;">Supprimer</button>
            <button name="back" class="btn btn-dark btn-popup-sm" style="margin-top: 24px;">Retour</button>
            <button name="save" class="btn bg-primary btn-popup-sm float-right" style="margin-top: 24px;">Enregistrer</button>
        </div>
    </div>
</section>

<div class="content-wrapper kanban">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text"><?= $project->name ?>
                        <div class="btn-group" style="margin-left: 48px">
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('projects')">Retour</div>
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('projects-edit', {'PID': '<?= $PID ?>'})">Éditer</div>
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('projects-changelog', {'PID': '<?= $PID ?>'})">Changelog</div>
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('projects-kanban', {'PID': '<?= $PID ?>'})">Actualiser</div>
                        </div>
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
                    <div class='card-tools'>
                        <a class='btn btn-tool a'>
                            <i class='fas fa-plus'></i>
                        </a>
                    </div>
                </div>
                <div class="card-body">
                    <?= $kb->columns['BACKLOG'] ?>
                </div>
            </div>

            <div name="column" class="card card-row card-primary">
                <div class="card-header">
                    <h3 class="card-title">A faire</h3>
                    <div class='card-tools'>
                        <a class='btn btn-tool a'>
                            <i class='fas fa-plus'></i>
                        </a>
                    </div>
                </div>
                <div class="card-body">
                    <?= $kb->columns['TODO'] ?>
                </div>
            </div>

            <div name="column" class="card card-row card-default">
                <div class="card-header bg-info">
                    <h3 class="card-title">En cours</h3>
                    <div class='card-tools'>
                        <a class='btn btn-tool a'>
                            <i class='fas fa-plus'></i>
                        </a>
                    </div>
                </div>
                <div class="card-body">
                    <?= $kb->columns['INPROGRESS'] ?>
                </div>
            </div>

            <div name="column" class="card card-row card-success">
                <div class="card-header">
                    <h3 class="card-title">Terminé</h3>
                    <div class='card-tools'>
                        <button class="btn btn-tool btn-success btn-sm" style="margin-top:-16px">Archiver</button>
                    </div>
                </div>
                <div class="card-body">
                    <?= $kb->columns['FINISHED'] ?>
                </div>
            </div>


        </div>
    </div>
</div>