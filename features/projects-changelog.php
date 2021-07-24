<?php

    require("dist/php/projects.php");

    $UID = $_SESSION['ID'];
    $IID = $_SESSION['INSTANCE_ID'];
    $PID = GetPostValue('PID', 'NEW');

    $db = new DataBase;
    $projects = unserialize($_SESSION['PROJECTS']);
    $project = $projects->GetProjectFromID($PID);

    if (isset($_POST['restore'])) {
        $restore_id = 0;
        $restore_index = $_POST['restore'];
        $restore_block = "";

        // Get restore & Delete from changelog
        $changelogs = explode("#", $project->changelog);
        for ($i = 0; $i < count($changelogs); $i++) {
            $parts = explode("\t", $changelogs[$i]);
            if ($parts[0] === "B") {
                if ($restore_id == $restore_index) {
                    $restore_block = array_splice($changelogs, $i, 1)[0];
                    break;
                }
                $restore_id++;
            }
        }

        // Check if tag is alone
        $tag_is_after_block = false;
        for ($i = count($changelogs) - 1; $i >= 0 ; $i--) {
            $parts = explode("\t", $changelogs[$i]);
            if ($parts[0] === "B" && !$tag_is_after_block) {
                $tag_is_after_block = true;
            } else if ($parts[0] === "T") {
                if (!$tag_is_after_block) {
                    array_splice($changelogs, $i, 1);
                    break; // One max at time
                }
                $tag_is_after_block = false;
            }
        }

        $new_changelogs = join("#", $changelogs);
        $project->SaveChangelog($db, $new_changelogs);

        // Format block : Changelog -> Kanban
        $parts = explode("\t", $restore_block);
        $new_restore_block = join("\t", [ $parts[1], $parts[2], $parts[6], $parts[7] ]);

        // Add to last column
        $split_content = explode("---", $project->content);
        $blocks = explode("#", $split_content[3]);
        if ($blocks[0] == "") {
            $split_content[3] = $new_restore_block;
        } else {
            array_push($blocks, $new_restore_block);
            $split_content[3] = join("#", $blocks);
        }
        $project->SaveContent($db, join("---", $split_content));
        $_SESSION['PROJECTS'] = serialize($projects);
    }

    if (isset($_POST['delete_all'])) {
        $project->SaveChangelog($db, '');
        $_SESSION['PROJECTS'] = serialize($projects);
    }

    $content = $project->getChangelogHTML();

?>

<input id="PID" value="<?= $PID ?>" style="display: none;">

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text"><?= $project->name ?>
                        <div class="btn-group" style="margin-left: 48px">
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('projects-kanban', {'PID': '<?= $PID ?>'})">Retour</div>
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('projects-changelog', {'PID': '<?= $PID ?>'})">Actualiser</div>
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('projects-changelog', {'PID': '<?= $PID ?>', 'delete_all': '1'})">Réinitialiser</div>
                        </div>
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

    <section class="content">
        <div class="container-fluid">

            <div class="row">
                <div class="col-md-6 card-center">
                    <div class="timeline">

                        <?= $content ?>

                    </div>
                </div>
            </div>

        </div>
    </section>
</div>