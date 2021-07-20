<?php

    function DeleteAndBack($file) {
        if (file_exists($file))
            unlink($file);
        echo "<script>window.location.href = \"./projects\";</script>";
        exit();
    }

    $ID = $_SESSION['ID'];
    $inst = $_SESSION['INSTANCE'];
    $id = $_GET['id'];
    $project_file = "instances/$inst/$ID/Projects/project{$id}.pro";
    $all_types = [ 'Logiciel', 'Algorithme Console', 'Embarqué', 'Application Android', 'Application IOS', 'Site Web', 'Embarqué / Logiciel', 'Jeux Vidéo' ];
    $all_status = [ 'Pas commencé', 'En cours', 'En attente', 'Phase de test', 'Terminé' ];
    $all_colors = [ 'primary' => 'Bleu', 'secondary' => 'Gris', 'success' => 'Vert', 'info' => 'Turquoise', 'danger' => 'Rouge', 'indigo' => 'Indigo', 'navy' => 'Bleu Marine', 'lightblue' => 'Bleu clair', 'teal' => 'Vert Clair', 'cyan' => 'Cyan', 'yellow' => 'Jaune', 'orange' => 'Orange' ];

    if (isset($_REQUEST['delete']))
        DeleteAndBack($project_file);

    if (isset($_REQUEST['save']))
    {
        $header = join(',', array($_REQUEST['tb_projectName'], str_replace('/', '.', $_REQUEST['tb_date']), $_REQUEST['lb_type'], $_REQUEST['tb_users'], $_REQUEST['tb_progress'], $_REQUEST['lb_status'], strtolower($_REQUEST['lb_color'])))."\r\n\r\n";
        $body = $_REQUEST['tb_content'];
        file_put_contents($project_file, $header . $body);
        echo "<script>window.location.href = \"./projects\";</script>";
        exit();
    }

    if (file_exists($project_file))
    {
        $lines = explode("\r\n", file_get_contents($project_file));
        list($projectname, $date, $type, $users, $progress, $status, $colorstatus) = explode(',', $lines[0]);
        $date = str_replace('.', '/', $date);
        $content = join("\n", array_slice($lines, 1));
    }
    else
    {
        $projectname = '';
        $date = date("d/m/yy");
        $type = '';
        $users = '';
        $progress = '0';
        $status = '';
        $colorstatus = '';
        $content = '';
    }
    
?>
<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Modifier un projet</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a href="./user"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item"><a href="./projects">Projects</a></li>
                        <li class="breadcrumb-item active">Editproject</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">
            <!-- Main content -->

            <form action="" method="POST" autocomplete="off">
                <div class="row">
                    <div class="col-md-6">
                        <div class="card card-primary">
                            <div class="card-header">
                                <h3 class="card-title">En-tête</h3>
                                <div class="card-tools">
                                    <button type="button" class="btn btn-tool" data-card-widget="collapse" data-toggle="tooltip" title="Collapse">
                                    <i class="fas fa-minus"></i></button>
                                </div>
                            </div>
                            <div class="card-body">
                                <div class="row">
                                    <div class="col-2">
                                        <!-- ID -->
                                        <div class="form-group">
                                            <label for="inputName">ID</label>
                                            <input type="text" id="inputName" class="form-control" value="<?= $_GET['id'] ?>" disabled>
                                        </div>
                                    </div>
                                    <div class="col-7">
                                        <!-- Project Name -->
                                        <div class="form-group">
                                            <label for="inputName">Nom du projet</label>
                                            <input type="text" id="inputName" name="tb_projectName" class="form-control" autocomplete="off" value="<?= $projectname ?>" required>
                                        </div>
                                    </div>
                                    <div class="col-3">
                                        <!-- Start Date -->
                                        <div class="form-group">
                                            <label for="inputDate">Date de commencement</label>
                                            <div class="input-group">
                                                <div class="input-group-prepend">
                                                    <span class="input-group-text"><i class="far fa-calendar-alt"></i></span>
                                                </div>
                                                <input id="inputDate" name="tb_date" type="text" class="form-control" data-mask="00/00/0000" data-mask-selectonfocus="true" value="<?= $date ?>" required>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <!-- Project Type -->
                                <div class="form-group">
                                    <label for="inputType">Type de projet</label>
                                    <select id="inputType" name="lb_type" class="form-control custom-select" selected="Embarqué" required>
                                        <option selected="" disabled="">Sélectionnez un type de projet</option>
                                        <?php
                                            foreach ($all_types as $t) {
                                                $selected = $type == $t ? 'selected=""' : '';
                                                echo "<option $selected>$t</option>";
                                            }
                                        ?>
                                    </select>
                                </div>
                                <!-- Avatars -->
                                <div class="form-group">
                                    <label for="inputUsers">Personnes</label>
                                    <input type="text" id="inputUsers" name="tb_users" class="form-control" value="<?= $users ?>" required>
                                </div>
                                <!-- Progress -->
                                <div class="form-group">
                                    <label for="inputEstimatedDuration">Progression</label>
                                    <input type="number" id="inputEstimatedDuration" name="tb_progress" class="form-control" value="<?= $progress ?>" step="10" required>
                                </div>
                                <div class="row">
                                    <div class="col-6">
                                        <!-- Status -->
                                        <div class="form-group">
                                            <label for="inputStatus">Statut</label>
                                            <select id="inputStatus" name="lb_status" class="form-control custom-select" required>
                                                <option selected="" disabled="">Sélectionnez un statut</option>
                                                <?php
                                                    foreach ($all_status as $s) {
                                                        $selected = $status == $s ? 'selected=""' : '';
                                                        echo "<option $selected>$s</option>";
                                                    }
                                                ?>
                                            </select>
                                        </div>
                                    </div>
                                    <div class="col-6">
                                        <!-- Color Status -->
                                        <div class="form-group">
                                            <label for="inputColorStatus">Couleur du statut</label>
                                            <select id="inputColorStatus" name="lb_color" class="form-control custom-select" required>
                                                <option selected="" disabled="">Sélectionnez une couleur</option>
                                                <?php
                                                    foreach ($all_colors as $color => $color_str) {
                                                        $selected = "$colorstatus" == $color ? 'selected=""' : '';
                                                        echo "<option class='bg-$color' $selected value='$color'>$color_str</option>";
                                                    }
                                                ?>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-6">
                        <div class="card card-primary">
                            <div class="card-header">
                                <h3 class="card-title">Contenu</h3>

                                <div class="card-tools">
                                    <button type="button" class="btn btn-tool" data-card-widget="collapse" data-toggle="tooltip" title="Collapse">
                                    <i class="fas fa-minus"></i></button>
                                </div>
                            </div>
                            <div class="card-body">
                                <!-- Content -->
                                <div class="form-group">
                                    <label for="inputContent">Contenu du projet</label>
                                    <textarea id="inputContent" name="tb_content" class="form-control" rows="14"><?= $content ?></textarea>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="row">
                    <div class="col-3"></div>
                    <div class="col-md-6">
                        <div class="card card-primary">
                            <div class="card-header">
                                <h3 class="card-title">Options avancées</h3>

                                <div class="card-tools">
                                    <button type="button" class="btn btn-tool" data-card-widget="collapse" data-toggle="tooltip" title="Collapse">
                                    <i class="fas fa-minus"></i></button>
                                </div>
                            </div>
                            <div class="card-body">
                                <!-- Project Name -->
                                <div class="form-group float-center">
                                    <button class='btn btn-success btn-lg' type="sumbit" name="save">
                                        <i class='fas fa-edit'></i>
                                        Sauvegarder
                                    </button>
                                </div>
                                <div class="form-group float-right">
                                    <button class='btn btn-danger btn-xs' type="submit" name="delete">
                                        <i class='fas fa-trash-alt'></i> Supprimer le projet
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </form>
            
            <!-- End Main content -->
        </div>
    </div>
</div>

<script type="text/javascript" src="plugins/inputmask/jquery-3.0.0.min.js"></script>
<script type="text/javascript" src="plugins/inputmask/jquery.mask.js"></script>