<?php

    /**
     * @var DataBase $db
     * @var User $user
     */

    /** @param Feature $feature */
    function AddFeature($feature, $enabled = true) {
        $class = $enabled ? '' : ' class="disabled"';
        $icon = $enabled ? 'open' : 'close';
        return "<li data-id=\"{$feature->ID}\"$class>
                    <span class=\"icon icon-drag\" title=\"Déplacer la fonctionnalité\"></span>
                    <p>{$feature->Name}</p>
                    <span class=\"icon icon-eye-$icon\" title=\"Activer ou désactiver la fonctionnalité\"></span>
                </li>";
    }
    function GetTFA($tfa) {
        if ($tfa === null) {
            return "Désactivé<img src='./assets/icons/error.svg' alt='Error icon'></img>";
        }
        return "<a id='delete-tfa'>Supprimer</a>Activé<img src='./assets/icons/success.svg' alt='Success icon'></img>";
    }

    /**
     * @param Feature[] $features
     * @param User $user
     * @param array $tree
     * @param int $level
     * @return string Return HTML elements of all features
     */
    function DefineFeatures($features, $user, $tree, $level = 0) {
        $featuresHTML = '';
        foreach ($tree as $key => $value) {
            $keyType = gettype($key);
            if ($keyType === 'string') {
                $featuresHTML .= DefineFeatures($features, $user, $value, $level + 1);
            } else if ($keyType === 'integer') {
                $feature = Feature::GetFeatureByID($value, $features);
                if ($feature === null) continue;
                $featureEnabled = $feature->Enabled;
                if (array_key_exists($feature->ID, $user->Settings)) {
                    $featureEnabled = $user->Settings[$feature->ID];
                }
                $featuresHTML .= AddFeature($feature, $featureEnabled);
            }
        }

        return $featuresHTML;
    }

    // Save features settings
    $input = file_get_contents('php://input');
    $data = json_decode($input, true);
    $action = $data['action'];
    $features = $data['features'];
    if (isset($action, $features) && $action === 'saveSettings') {
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
        'features' => $featuresHTML
    );

    $content = ImportHTML(__DIR__.'/index.html', $vars);
    echo($content);

    // TODO - Coder le changement de mdp
    /*if (isset($_POST['changepassword'], $_POST['newpassword'])) {
        $_status = "FAIL";
        $password = $_POST['changepassword'];
        $password_new = $_POST['newpassword'];

        // Check password validity
        $db = new DataBase;
        $req_user = $db->GetRowContent('Users', 'ID', $user->Username);
        if (isset($req_user)) {
            if (password_verify($password, $req_user['Password'])) {
                $hash = password_hash($password_new, PASSWORD_BCRYPT);
                $db->SetCellContent('Users', 'Password', $req_user['ID'], $hash, false);
                $db->AddLog($_SESSION['ID'], 'instanceEdit', "Password changed successfully.");
                $_status = "OK";
            } else {
                $db->AddLog($_SESSION['ID'], 'instanceEdit', "Password changing failed (wrong password) !");
                $_status = "WRONG";
            }
        }

        echo($_status);
        exit();
    }*/

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