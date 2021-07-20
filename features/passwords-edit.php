<?php

    $username = $_SESSION['USERNAME'];
    $team = GetPostValue('team', false);
    $ID = $team ? $_SESSION['INSTANCE_ID'] : $_SESSION['ID'];
    $table = $team ? 'Instances' : 'Users';

    $content = GetCellContent($table, 'Passwords', $ID);
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
                        <button type="button" class="btn btn-success btn-sm col-2 fbtn" style="display: inline; margin-left: 24px;" onclick="SavePasswords(<?= $team_txt ?>);">Sauvegarder</button>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $username ?></a></li>
                        <li class="breadcrumb-item"><a onclick="LoadPage('passwords', {'team': <?= $team_txt ?>});">Passwords<?= $title_txt ?></a></li>
                        <li class="breadcrumb-item active">Edit</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">
            <section class="col-lg-12">
                <div class="card card-primary card-outline">
                    <div class="card-header border-1">
                        <h3 class="card-title"><i class="fas fa-align-left mr-1"></i>Edition des mots de passe</h3>
                    </div>
                    <div class="card-body" style="text-align: left;">
                        <div class="card">
                            <textarea id="inputContent" name="tb_content" class="form-control" rows="18" placeholder="# Catégorie&#10;Service,Identifiant/Mail,Mot de passe[,status]&#10;&#10;# Catégorie 2&#10;Service,Identifiant/Mail,Mot de passe[,status]"><?= $content ?></textarea>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </div>
</div>