<?php

    require(__DIR__.'/utils.php');

    /**
     * @var DataBase $db
     * @var User $user
     */

    // Change password
    $action = $post['action'];
    if (isset($action) && $action === 'passwordEdit') {
        $status = array('status' => 'error');

        $passwordOld = $post['passwordOld'];
        $passwordNew = $post['passwordNew'];

        // Check password validity
        if ($passwordOld === $passwordNew) {
            $db->AddLog($user->ID, 'passwordEdit', "Password changing failed (same password) !");
        } else if (password_verify($passwordOld, $user->Password)) {
            $hash = password_hash($passwordNew, PASSWORD_BCRYPT);
            $db->SetCellContent('Users', 'Password', $user->ID, $hash, false);
            $db->AddLog($user->ID, 'passwordEdit', "Password changed successfully.");
            $status['status'] = 'ok';
        } else {
            $db->AddLog($user->ID, 'passwordEdit', "Password changing failed (wrong password) !");
        }

        echo(json_encode($status));
        exit();
    }

    // Save features settings
    if (isset($action, $post['features']) && $action === 'saveSettings') {
        $features = $post['features'];
        // Remove first character of each key in array
        $removeFirst = fn($k) => StartsWith($k, 'f-') ? substr($k, 2) : $k;
        $newKeys = array_map($removeFirst, array_keys($features));
        $features = array_combine($newKeys, array_values($features));

        $newFeatures = json_encode($features);
        $result = $db->Query("UPDATE `Users` SET `Settings` = '$newFeatures' WHERE `ID` = {$user->ID}");
        if ($result === false) {
            throw new Exception("Settings could not be saved.");
        }
        $return = array('status' => 'ok');
        echo(json_encode($return));
        exit();
    }

    // Get features settings
    $rawFeatures = $db->QueryArray("SELECT * FROM `Features` WHERE `Level` <= {$user->Level}");
    $features = array_map(fn($f) => Feature::Load($f), $rawFeatures);
    $tree = Feature::GetTree($user, $features, $GLOBALS['LEVEL_TEXTS'], true);
    $featuresHTML = DefineFeatures($features, $user, $tree);
    $featuresOptions = DefineOptions($features, $user, $tree);

    // Print page
    $status = $user->Level === 0 ? '' : "<h3>{$LEVEL_TEXTS[$user->Level]}</h3>";
    $vars = array(
        'status' => $status,
        'username' => $user->Username,
        'email' => $user->Email,
        'avatar' => $user->Avatar,
        'instance' => 0,
        '2fa' => GetTFA($user->TwoFactorAuth),
        'date' => date('d/m/Y H:i', $user->Created),
        'features' => $featuresHTML,
        'options' => $featuresOptions
    );

    $content = ImportHTML(__DIR__.'/index.html', $vars);
    echo($content);

    // TODO - Récup le nombre d'Instances
    /*$instance = 0;
    $instanceID = 0;
    // Get instance length
    if ($instanceID > 0) {
        $db = new DataBase;
        $instance_length = 0;
        $result = $db->Query("SELECT ID FROM `Users` WHERE `InstanceID` = '$instanceID'");
        if (isset($result)) {
            $instance_length = $result->num_rows;
        }
        $instance .= " ($instance_length membre" . ($instance_length > 1 ? 's)' : ')');
    }*/

    // TODO - Rajouter l'icone (double auth ? Validation du mail ?)
    //$icon_ok = '<i class="fas fa-check-circle" style="color: green; margin-left: 6px;"></i>';
    //$icon_ko = '<i class="fas fa-times-circle" style="color: red; margin-left: 6px;"></i>';
    //$mailIcon = $email_ok ? $icon_ok : $icon_ko;

?>