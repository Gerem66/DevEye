<?php

    /**
     * @var User $user
     * @var DataBase $db
     * @var Feature[] $features
     */

    include_once(__DIR__.'/utils.php');

    /**
     * @param DataBase $db
     * @param User $user
     * @param string $type
     * @param array $args
     * @return string String returned to the client
     */
    $action = function($db, $user, $type, $args) {
        // Change password
        if ($type === 'passwordEdit') {
            $status = 'error';

            $passwordOld = $args['passwordOld'];
            $passwordNew = $args['passwordNew'];

            // Check password validity
            if ($passwordOld === $passwordNew) {
                $db->AddLog($user->ID, 'passwordEdit', "Password changing failed (same password) !");
            } else if (password_verify($passwordOld, $user->Password)) {
                $hash = password_hash($passwordNew, PASSWORD_BCRYPT);
                $db->QueryPrepare('Users', 'UPDATE TABLE SET `Password` = ? WHERE `ID` = ?', 'si', [$hash, $user->ID]);
                $db->AddLog($user->ID, 'passwordEdit', "Password changed successfully.");
                $status = 'ok';
            } else {
                $db->AddLog($user->ID, 'passwordEdit', "Password changing failed (wrong password) !");
            }

            return $status;
        }

        // Save features settings
        if ($type === 'saveSettings') {
            $features = $args['features'];
            // Remove first character of each key in array
            $removeFirst = fn($k) => StartsWith($k, 'f-') ? substr($k, 2) : $k;
            $newKeys = array_map($removeFirst, array_keys($features));
            $features = array_combine($newKeys, array_values($features));

            $newFeatures = json_encode($features);
            $result = $db->QueryPrepare('Users', "UPDATE TABLE SET `Settings` = ? WHERE `ID` = ?", 'si', array($newFeatures, $user->ID));
            if ($result === false) {
                throw new Exception("Settings could not be saved.");
            }
            return 'ok';
        }
    };

    // Get features settings
    $tree = Feature::GetTree($user, $features, $GLOBALS['LEVEL_TEXTS'], true);
    $featuresHTML = DefineFeatures($features, $user, $tree);
    $featuresOptions = DefineOptions($features, $user, $tree);

    // Print page
    global $LEVEL_TEXTS;
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

    return ImportHTML(__DIR__.'/index.html', $vars);

?>