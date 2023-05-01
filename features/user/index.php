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
     * @return array Array returned to the client
     */
    $action = function($db, $user, $type, $args) {
        $status = array('status' => 'error');

        // Change password
        if ($type === 'passwordEdit') {
            $passwordOld = $args['passwordOld'];
            $passwordNew = $args['passwordNew'];

            // Check password validity
            if ($passwordOld === $passwordNew) {
                $db->AddLog($user->ID, $user->IP, 1, 'update', 'Password changing failed (same password) !');
            } else if (password_verify($passwordOld, $user->Password)) {
                // TODO
                // - Backup temporaire (Variables flash ? DB ? File ?)
                // - Get all "content" tables
                // - Decrypt & Encrypt new content
                // - Special tables (user (password hash), other ?)
                // - Check data ? Progressbar ?
                // - Supprimer la backup

                $newHashedPassword = $db->encryption->HashPassword($passwordNew);
                $allTables = $db->GetTables();
                $conTables = array_filter($allTables, fn($t) => StartsWith($t, '_'));

                // Temporary backup to prevent [data lost]
                $tempBackup = array();
                foreach ($conTables as $table) {
                    $content = $db->QueryPrepare($table, "SELECT * FROM TABLE WHERE `UID` = ?", 'i', [ $user->ID ]);
                    if ($content === false) {
                        // TODO - Manage error
                        return false;
                    }
                    $tempBackup[$table] = $content;
                }

                // TODO - Save backup
                // Save $tempBackup (not only in variable because if script crash, all data can be lost)

                foreach ($conTables as $table) {
                    $content = $db->QueryPrepare($table, "SELECT `Content` FROM TABLE WHERE `UID` = ?", 'i', [ $user->ID ]);
                    $decrypted = $db->encryption->Decrypt($content, $user->hashedPassword);
                    $newEncrypted = $db->encryption->Encrypt($decrypted, $newHashedPassword);
                    $result = $db->QueryPrepare($table, "UPDATE TABLE WHERE `UID` = ? SET `Content` = ?", 'is', [ $user->ID, $newEncrypted ]);
                    if ($result === false) {
                        // TODO - Manage error
                        return false;
                    }
                }

                // Store new password's hash
                $hash = password_hash($passwordNew, PASSWORD_BCRYPT);
                $db->QueryPrepare('Users', 'UPDATE TABLE SET `Password` = ? WHERE `ID` = ?', 'si', [$hash, $user->ID]);
                $db->AddLog($user->ID, $user->IP, 1, 'update', 'Password changed successfully.');

                // TODO - Delete backup
                $status['status'] = 'ok';
            } else {
                $db->AddLog($user->ID, $user->IP, 1, 'update', 'Password changing failed (wrong password) !');
            }
        }

        // Save features settings
        else if ($type === 'saveSettings') {
            $features = $args['features'];
            // Remove first character of each key in array
            $removeFirst = fn($k) => StartsWith($k, 'f-') ? substr($k, 2) : $k;
            $newKeys = array_map($removeFirst, array_keys($features));
            $features = array_combine($newKeys, array_values($features));

            $newFeatures = json_encode($features);
            $result = $db->QueryPrepare('Users', "UPDATE TABLE SET `Settings` = ? WHERE `ID` = ?", 'si', array($newFeatures, $user->ID));
            $user->Settings = $features;

            if ($result !== false) {
                $status['status'] = 'ok';
            }

            // Re-load sidebar if needed
            if (isset($args['refreshSidebar']) && $args['refreshSidebar']) {
                $sidebar = GenerateSidebar($db, $user);
                $status['sidebar'] = $sidebar;
            }
        }

        return $status;
    };

    // Get features settings
    $tree = Feature::GetTree($user, $features, $GLOBALS['LEVEL_TEXTS'], true);
    $featuresHTML = DefineFeatures($features, $user, $tree);
    $featuresOptions = DefineOptions($features, $user, $tree);

    // Print page
    global $LEVEL_TEXTS;
    $status = $user->Level === 0 ? '' : "<h3>{$LEVEL_TEXTS[$user->Level]}</h3>";

    // Get last connection
    $connectionDescription = 'User login successful.';
    $command = 'SELECT `Date` FROM TABLE WHERE `UID` = ? AND `Description` = ? ORDER BY `Date` DESC LIMIT 2';
    $logsConnections = $db->QueryPrepare('Logs', $command, 'is', array($user->ID, $connectionDescription));

    $lastConnection = 'Aucune';
    if (count($logsConnections) === 2) {
        $dates = array_map(fn($log) => date('d/m/Y H:i:s', strtotime($log['Date'])), $logsConnections);
        $lastConnection = $dates[1];
    }

    $vars = array(
        'status' => $status,
        'username' => $user->Username,
        'email' => $user->Email,
        'avatar' => $user->Avatar,
        'instance' => 0,
        '2fa' => GetTFA($user->TwoFactorAuth),
        'lastConnection' => $lastConnection,
        'date' => date('d/m/Y H:i', $user->Created),
        'features' => $featuresHTML,
        'options' => $featuresOptions
    );

    $content = ImportHTML(__DIR__.'/popups.html');
    $content .= ImportHTML(__DIR__.'/index.html', $vars);
    return $content;

?>