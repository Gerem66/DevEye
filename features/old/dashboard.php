<?php

    //exec("ping -c 1 0.0.0.0", $o, $r_DHCP);
    //exec("ping -c 1 0.0.0.0", $o, $r_NAS);
    //exec("ping -c 1 0.0.0.0", $o, $r_WEB);
    //exec("ping -c 1 0.0.0.0", $o, $r_PC);
    //$temp = exec("cat /sys/class/thermal/thermal_zone0/temp") / 1000;
    //$SUCCESS = "<td class='project-state'><span class='badge badge-success'>Connecté</span></td>";
    //$ERROR   = "<td class='project-state'><span class='badge badge-danger'>Déconnecté</span></td>";
    //$result_DHCP = $r_DHCP == 0 ? $SUCCESS : $ERROR;
    //$result_NAS = $r_NAS == 0 ? $SUCCESS : $ERROR;
    //$result_WEB = $r_WEB == 0 ? $SUCCESS : $ERROR;
    //$result_PC = $r_PC == 0 ? $SUCCESS : $ERROR;

    $action = $_POST['action'];
    $ip = $_POST['ip'];

    if (isset($action)) {
        switch ($action) {
            case 'temperature':
                echo exec("cat /sys/class/thermal/thermal_zone0/temp") / 1000;
                break;
            case 'ping':
                if (isset($ip)) {
                    exec("ping -c 1 ".$ip, $o, $r_ping);
                    echo $r_ping == 0 ? "OK" : "NO";
                }
                break;
        }
        exit();
    }

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
            <!-- Main content -->

            <!-- Info boxes -->
            <div class="row">
            <div class="col-12 col-sm-6 col-md-3">
                <div class="info-box">
                <span class="info-box-icon bg-info elevation-1"><i class="fas fa-cog"></i></span>

                <div class="info-box-content">
                    <span id="bt_1" class="info-box-text"></span>
                    <span id="bn_1" class="info-box-number"></span>
                </div>
                <!-- /.info-box-content -->
                </div>
                <!-- /.info-box -->
            </div>
            <!-- /.col -->
            <div class="col-12 col-sm-6 col-md-3">
                <div class="info-box mb-3">
                <span class="info-box-icon bg-danger elevation-1"><i class="fas fa-server"></i></span>

                <div class="info-box-content">
                    <span id="bt_2" class="info-box-text"></span>
                    <span id="bn_2" class="info-box-number"></span>
                </div>
                <!-- /.info-box-content -->
                </div>
                <!-- /.info-box -->
            </div>
            <!-- /.col -->

            <!-- fix for small devices only -->
            <div class="clearfix hidden-md-up"></div>

            <div class="col-12 col-sm-6 col-md-3">
                <div class="info-box mb-3">
                <span class="info-box-icon bg-success elevation-1"><i class="fas fa-window-maximize"></i></span>

                <div class="info-box-content">
                    <span id="bt_3" class="info-box-text"></span>
                    <span id="bn_3" class="info-box-number"></span>
                </div>
                <!-- /.info-box-content -->
                </div>
                <!-- /.info-box -->
            </div>
            <!-- /.col -->
            <div class="col-12 col-sm-6 col-md-3">
                <div class="info-box mb-3">
                <span class="info-box-icon bg-warning elevation-1"><i class="fas fa-desktop"></i></span>

                <div class="info-box-content">
                    <span id="bt_4" class="info-box-text"></span>
                    <span id="bn_4" class="info-box-number"></span>
                </div>
                <!-- /.info-box-content -->
                </div>
                <!-- /.info-box -->
            </div>
            <!-- /.col -->
            </div>
            <!-- /.row -->

                <!--iframe src="http://admin:rasp@10.42.0.202" width="100%" height="625"></iframe-->

            
            
            <!-- End Main content -->
        </div>
    </div>
</div>

<script src="./dist/js/jquery.js"></script>
<script src="./dist/js/request.js"></script>
<script>
    let temperature = 0;
    let req_temperature = Request({"action": "temperature"});
    if (req_temperature[0] > 0)
        temperature = req_temperature[1];
    let boxes = [
        [document.getElementById("bt_1"), document.getElementById("bn_1")],
        [document.getElementById("bt_2"), document.getElementById("bn_2")],
        [document.getElementById("bt_3"), document.getElementById("bn_3")],
        [document.getElementById("bt_4"), document.getElementById("bn_4")]
    ];
    let contents = [
        ["Serveur DHCP (Temp : " + temperature + "°C)", "10.42.0.1"],
        ["NAS", "10.42.0.143"],
        ["Accès Internet", "www.google.com"],
        ["Geremy.eu", "geremy.eu"]
    ];
    let req;
    var lb_success = "<td class='project-state'><span class='badge badge-success'>Connecté</span></td>";
    var lb_wait = "<td class='project-state'><span class='badge badge-warning'>Connexion</span></td>";
    var lb_error = "<td class='project-state'><span class='badge badge-danger'>Déconnecté</span></td>";
    if (boxes.length == contents.length) {
        // Set text
        for (let i = 0; i < boxes.length; i++) {
            boxes[i][0].innerHTML = contents[i][0];
            boxes[i][1].innerHTML = lb_wait;
            AsyncRequest({"action": "ping", "ip": contents[i][1]}, (status, output) => { boxes[i][1].innerHTML = (status > 0) ? lb_success : lb_error; console.log("Status ["+i+"] : "+status); });
        }
        // Set status
        //for (let i = 0; i < boxes.length; i++) {
            //AsyncRequest({"action": "ping", "ip": contents[i][1]}, (status, output) => { boxes[i][1].innerHTML = (status > 0) ? lb_success : lb_error; });
            //AsyncRequest("", "", {"action": "ping", "ip": contents[i][1]});
            //boxes[i][1].innerHTML = (req[0] > 0) ? lb_success : lb_error;
        //}
    }
</script>