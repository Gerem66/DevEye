<?php

    $username = $_SESSION['USERNAME'];
    $team = GetPostValue('team', 0);

    if (isset($_POST['save']) && isset($_POST['tb_content'])) {
        $ID = $team ? $_SESSION['INSTANCE_ID'] : $_SESSION['ID'];
        $table = $team ? 'Instances' : 'Users';
        SaveCellContent($table, 'Passwords', $ID, $_POST['tb_content']);
    }

    function LinesToTable($lines) {
        function OpenSection($title) {
            return '<section class="col-lg-10" style="margin-left: auto;margin-right: auto;">
                        <div class="card card-primary card-outline collapsed-card">
                            <div class="card-header border-1">
                                <h3 class="card-title"><i class="fas fa-align-left mr-1"></i>'.$title.'</h3>
                                <div class="card-tools">
                                    <button type="button" class="btn bg-primary btn-sm" data-card-widget="collapse" style="margin-right: 8px;"><i class="fas fa-plus"></i></button>
                                </div>
                            </div>

                            <div class="card-body" style="text-align: left;">
                                <div class="col-12">
                                    <div class="card">
                                        <div class="card-body table-responsive p-0">
                                            <table class="table table-head-fixed text-nowrap">
                                            <thead>
                                                <tr>
                                                    <th style="width: 30%;">Service</th>
                                                    <th style="width: 30%;">Nom d\'utilisateur / Email</th>
                                                    <th style="width: 20%;">Mot de passe</th>
                                                    <th style="width: 20%;">État</th>
                                                </tr>
                                            </thead>
                                            <tbody>';
        }

        function EndSection() {
            return '</tbody></table></div></div></div>
                    </div></div></section>'; // End Table / Section
        }

        $content = '';
        $indiv = false;
        if (count($lines) > 1) {
            foreach ($lines as $line)
            {
                if (startsWith($line, '#'))
                {
                    if ($indiv) $content .= EndSection();
                    $content .= OpenSection(substr($line, 2));
                    $indiv = true;
                } else if ($line == "\r") {
                    continue;
                } else {
                    list($site, $username, $password, $state) = explode(',', $line);
                    $s = $state == "" ? "<td style='color: #2ecc71;'>Activé</td>" : "<td style='color: #e74c3c;'>$state</td>";
                    $content .= "<tr>
                                    <td>$site</td>
                                    <td>$username</td>
                                    <td>$password</td>
                                    $s
                                </tr>";
                }
            }
        }
        if ($indiv) $content .= EndSection();

        return $content;
    }

    if ($team) $data = GetCellContent('Instances', 'Passwords', $_SESSION['INSTANCE_ID']);
    else $data = GetCellContent('Users', 'Passwords', $_SESSION['ID']);
    $lines = explode("\n", $data);

    $content = LinesToTable($lines);
    $icon = $team ? '<i class="fas fa-users" style="margin: 0 24px;"></i>' : '';
    $team_txt = $team ? '1' : '0';
    $title_txt = $team ? '-team' : '';

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text"><?= $icon ?>Mots de passe
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" style="display: inline; margin-left: 24px;" onclick="LoadPage('passwords-edit', {'team': <?= $team_txt ?>});">Modifier</button>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $username ?></a></li>
                        <li class="breadcrumb-item active">Passwords<?= $title_txt ?></li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">
            <?= $content ?>
        </div>
    </div>
</div>