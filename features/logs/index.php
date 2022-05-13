<?php

    require_once(__DIR__.'/utils.php');

    $post_id = isset($_REQUEST['id']) ? $_REQUEST['id'] : 0;

    $logs_count = $post_id <= 0 ? 10 : $post_id;
    $logs = GetLogsList();
    $logs_content = LogsToTable($logs, $logs_count);

    $bt_showall_id = $post_id == 0 ? '999' : '0';
    $bt_showall_text = intval($post_id) > 10 ? 'Réduire les logs' : 'Afficher tous les logs';;

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Logs</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">Logs</li>
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
                        <h3 class="card-title"><i class="fas fa-align-left mr-1"></i>Logs</h3>
                        <div class="card-tools">
                            <a class="btn bg-primary btn-sm" onclick="LoadPage('logs', {'id': '<?= $bt_showall_id ?>'})" style="margin-right: 8px;"><?= $bt_showall_text ?></a>
                        </div>
                    </div>
                    <div class="card-body">

                        <div class="col-12">
                            <div class="card">
                                <div class="card-body table-responsive p-0">
                                    <table class="table table-head-fixed text-nowrap">
                                        <thead>
                                            <tr>
                                                <th style="width: 5%;">ID</th>
                                                <th style="width: 5%;">ID Utilisateur</th>
                                                <th style="width: 10%;">IP</th>
                                                <th style="width: 60%;">Descritption</th>
                                                <th style="width: 20%;">Date</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <?= $logs_content ?>
                                        </tbody>
                                    </table>
                                </div>
                            <div>
                        </div>

                    </div>
                </div>
            </section>
        </div>
    </div>
</div>