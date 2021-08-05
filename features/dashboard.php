<?php

    /*$action = $_POST['action'];
    if (isset($action)) {
        switch ($action) {
            case 'temp':
                $temp = intval(exec("cat /sys/class/thermal/thermal_zone0/temp") / 1000);
                echo($temp);
                break;
            case 'ping':
                $ip = $_POST['ip'];
                if (isset($ip)) {
                    exec("ping -c 1 ".$ip, $o, $r_ping);
                    echo $r_ping == 0 ? "OK" : "NO";
                }
                break;
        }
        exit();
    }*/

    // Get OA users
    $db = new DataBase(true, [ 'localhost', 'u444572210_EisenhowApp', 'u444572210_gege', 'PasswordVERYstr0ng' ]);
    $result = $db->query("SELECT * FROM `Users`");
    $nb_total = $result->num_rows;
    $nb_logged = 0;
    while ($r = $result->fetch_assoc()) {
        if (!$r) break;
        if ($r['state'] == 1) {
            $nb_logged++;
        }
    }
    $users_OA = "$nb_logged utilisateurs ($nb_total)";

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Panneau de contrôle</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a href="./user"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">Dashboard</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">

            <!-- Info boxes -->
            <div class="row">
                <div class="col-12 col-sm-6 col-md-3">
                    <div class="info-box mb-3 bg-dark">
                        <img class="info-box-icon" src="dist/img/OrganizApp-min.png" alt="GameLife" />
                        <div class="info-box-content">
                            <span class="info-box-text">Organiz'App</span>
                            <span class="info-box-number"><?= $users_OA ?></span>
                        </div>
                    </div>
                </div>

                <div class="col-12 col-sm-6 col-md-3">
                    <div class="info-box bg-dark">
                        <img class="info-box-icon" src="dist/img/GameLife-min.png" alt="GameLife" />
                        <div class="info-box-content">
                            <span class="info-box-text">Game Life</span>
                            <span class="info-box-number">Pas encore publié</span>
                        </div>
                    </div>
                </div>

                <div class="col-12 col-sm-6 col-md-3">
                    <div class="info-box mb-3 bg-dark">
                        <div class="info-box-content">
                            <span class="info-box-text"></span>
                            <span class="info-box-number"></span>
                        </div>
                    </div>
                </div>
                <div class="col-12 col-sm-6 col-md-3">
                    <div class="info-box mb-3 bg-dark">
                        <div class="info-box-content">
                            <span class="info-box-text"></span>
                            <span class="info-box-number"></span>
                        </div>
                    </div>
                </div>
            </div>



        </div>
    </div>
</div>