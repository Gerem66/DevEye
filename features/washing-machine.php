<?php

    require("dist/php/proxiwash.php");

    // Get proxiwash informations
    $proxiwash_url = 'https://www.proxiwash.com/weblaverie/ma-laverie-2?s=cf4f39&16d33a57b3fb9a05d4da88969c71de74=1';
    $content = file_get_contents($proxiwash_url);

    // Parse content
    $html_machines = ParseMachines($content);

    // Final : html to tables
    $table_1 = join('', array_slice($html_machines, 0, 3));
    $table_2 = join('', array_slice($html_machines, 3));
    $table_1_free = substr_count($table_1, 'DISPONIBLE');
    $table_2_free = substr_count($table_2, 'DISPONIBLE');
    $table_1_free .= $table_1_free > 1 ? ' machines disponibles' : ' machine disponible';
    $table_2_free .= $table_2_free > 1 ? ' machines disponibles' : ' machine disponible';

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Proxiwash
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('washing-machine');">Actualiser [<p id="timer" style="display: inline;"></p>s]</button>
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="window.open('<?= $proxiwash_url ?>', '_blank');">Proxiwash</button>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">Washing-machine</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">



            <div class="col-md-8 card-center">
                <div class="card" style="overflow-x: auto;">
                    <div class="card-header">
                        <h3 class="card-title">Sèche-linge (14 kg)</h3>
                        <h3 class="card-title float-right"><?= $table_1_free ?></h3>
                    </div>
                    <div class="card-body p-0">
                        <table class="table table-striped">
                            <thead>
                                <tr>
                                    <th style="width: 10%">#</th>
                                    <th style="width: 15%">État</th>
                                    <th style="width: 30%">Programme</th>
                                    <th>Progression</th>
                                    <th style="width: 5%"></th>
                                    <th style="width: 14%">Temps restant</th>
                                </tr>
                            </thead>
                            <tbody>
                                <?= $table_1 ?>
                            </tbody>
                        </table>
                    </div>
                </div>


                <div class="card" style="overflow-x: auto;">
                    <div class="card-header">
                        <h3 class="card-title">Lave linge (6 kg)</h3>
                        <h3 class="card-title float-right"><?= $table_2_free ?></h3>
                    </div>
                    <div class="card-body p-0">
                        <table class="table table-striped">
                            <thead>
                                <tr>
                                    <th style="width: 10%">#</th>
                                    <th style="width: 15%">État</th>
                                    <th style="width: 30%">Programme</th>
                                    <th>Progression</th>
                                    <th style="width: 5%"></th>
                                    <th style="width: 14%">Temps restant</th>
                                </tr>
                            </thead>
                            <tbody>
                                <?= $table_2 ?>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>



        </div>
    </div>
</div>