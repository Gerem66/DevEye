<?php

    function AddFeatureSettings($index, $feature) {
        $status = $_SESSION['STATUS'];
        extract($feature);
        if ($status < $minLvl || !$title || !$canDisable) return;

        $settings = $_SESSION['SETTINGS'];
        $enabled = $settings == -1 || $settings & 1 << $index;
        $txt_active = $enabled ? 'active' : '';

        return "<li class='list-group-item'>
                    <i class='nav-icon fas fa-$icon' style='width: 24px; margin-right: 12px;'></i>
                    <b>$title</b>
                    <div id='$index' name='setting' class='bootstrap-switch bootstrap-switch-wrapper bootstrap-switch-focused bootstrap-switch-animate bootstrap-switch-on float-right' onclick='Switch(this)'>
                        <div class='bootstrap-switch-container setting-switch $txt_active'>
                            <span class='bootstrap-switch-handle-on bootstrap-switch-primary' style='width: 42px;'>ON</span>
                            <span class='bootstrap-switch-label' style='width: 42px;'>&nbsp;</span>
                            <span class='bootstrap-switch-handle-off bootstrap-switch-default bg-dark' style='width: 42px;'>OFF</span>
                        </div>
                    </div>
                </li>";
    }

    function AddOptionPage($index, $feature) {
        $status = $_SESSION['STATUS'];
        extract($feature);

        $enabled = SettingsEnabled($_SESSION['SETTINGS'], $index);
        if ($status < $minLvl || !$title || !$canDisable || !$enabled) return;

        $selected = $_SESSION['DEFAULT_PAGE'] == $index;
        $s = $selected ? ' selected' : '';

        return "<option$s value='$index'>$title</option>";
    }

    // Save features
    if (isset($_POST['save'])) {
        $ID = $_SESSION['ID'];
        $data = $_POST['save'];
        $db = new DataBase;
        $db->SaveCellContent('Users', 'Settings', $ID, $data, false);
        $_SESSION['SETTINGS'] = $data;
        $_SESSION['redirect'] = 'settings';
        exit();
    }

    // Save default page
    if (isset($_POST['save_dp'])) {
        $ID = $_SESSION['ID'];
        $data = $_POST['save_dp'];

        // Check
        $enabled = SettingsEnabled($_SESSION['SETTINGS'], $data);
        extract($_SESSION['FEATURES'][$data]);
        if (!$enabled) {
            $data = -1;
        }

        // Save local & external data value
        $_SESSION['DEFAULT_PAGE'] = $data;
        $db = new DataBase;
        $db->SaveCellContent('Users', 'DefaultPage', $ID, $data, false);
        exit();
    }

    $content = '';
    $options = '<option value="-1">User</option>';
    $features = $_SESSION['FEATURES'];
    for ($i = 0; $i < count($features); $i++) {
        $content .= AddFeatureSettings($i, $features[$i]);
        $options .= AddOptionPage($i, $features[$i]);
    }

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Settings</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">Settings</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">

            <div class="card card-primary card-outline col-6" style="margin: auto;">
                <div class="card-header"><h3 class="card-title">Page de démarrage</h3></div>
                <div class="card-body box-profile">
                    <div class="row">
                        <div class="col-8">
                            <select id="options_dp" class="form-control" onchange="SelectNewIndex()">
                                <?= $options ?>
                            </select>
                        </div>
                        <button id="bt-save-dp" type="button" class="btn btn-block bg-success col-4" onclick="SaveDefaultPage();" disabled>Sauvegarder</button>
                    </div>
                </div>
            </div>

            <div class="card card-primary card-outline col-6" style="margin: 1rem auto 0;">
                <div class="card-header"><h3 class="card-title">Features</h3></div>
                <div class="card-body box-profile">
                    <?= $content ?>
                    <button id="bt-save-settings" type="button" class="btn btn-block bg-success col-4" style="margin: 48px auto 12px" onclick="SaveSettings();" disabled>Sauvegarder</button>
                </div>
            </div>

        </div>
    </div>
</div>