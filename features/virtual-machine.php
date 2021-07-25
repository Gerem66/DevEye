<?php

    $devices = [ 'pixel4', 'iphone11pro' ];
    $version = [ '11.0', '14.0' ];

    $ID = $_POST['ID'];
    $selected = isset($ID) ? ($ID >= 0 && $ID < count($devices) ? $ID : 0) : 0;

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Virtual machine
                        <!--div class="btn-group" style="margin-left: 48px">
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('virtual-machine', {'ID': '0'})">Android (Pixel 4 - 11.0)</div>
                            <div class="btn btn-primary btn-sm fbtn" onclick="LoadPage('virtual-machine', {'ID': '1'})">IOS (Iphone 11 Pro - 14.0)</div>
                        </div-->
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">virtual-machine</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">

            <div style="display: flex; justify-content: center; align-items: center;">
                <iframe src="https://appetize.io/embed/ckn648a3t4ck0cfcxpmb5br6qr?device=<?= $devices[$selected] ?>&scale=75&orientation=portrait&osVersion=<?= $version[$selected] ?>" width="378px" height="800px" frameborder="0" scrolling="no"></iframe>
            <div>

        </div>
    </div>
</div>