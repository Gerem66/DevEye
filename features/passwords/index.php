<?php

    /**
     * @var User $user
     * @var DataBase $db
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
        switch ($type) {
            case 'add':
                $content = GetPasswordContent(
                    $db,
                    $user->hashedPassword,
                    $args['service'],
                    $args['username'],
                    $args['password'],
                    $args['status']
                );
                $success = AddPassword($db, $user->ID, $args['category'], $content);
                if (!$success) return 'error';
                return 'ok';
    
            case 'getPassword':
                $passwordIsCorrect = CheckPassword($db, $user->ID, $args['password']);
                if ($passwordIsCorrect === null) return 'error';
                if ($passwordIsCorrect === false) return 'wrong';
    
                // Get password
                $command = 'SELECT `Content` FROM TABLE WHERE `ID` = ? AND `UID` = ?';
                $result = $db->QueryPrepare('_Passwords', $command, 'ii', [$args['id'], $user->ID]);
                if ($result === false || count($result) === 0) return 'error';
                $content = $db->encryption->Decrypt($result[0]['Content'], $user->hashedPassword);
                return $content;
    
            case 'categoryEdit':
                $command = 'UPDATE TABLE SET `Category` = ? WHERE `Category` = ? AND `UID` = ?';
                $result = $db->QueryPrepare('_Passwords', $command, 'ssi', [$args['new'], $args['old'], $user->ID]);
                if ($result === false) return 'error';
                return 'ok';
    
            case 'edit':
                $content = GetPasswordContent(
                    $db,
                    $user->hashedPassword,
                    $args['service'],
                    $args['username'],
                    $args['password'],
                    $args['status']
                );
                $success = EditPassword($db, $user->ID, $args['id'], $args['category'], $content);
                if (!$success) return 'error';
                return 'ok';
    
            case 'move':
                $command = 'UPDATE TABLE SET `Category` = ? WHERE `ID` = ? AND `UID` = ?';
                $result = $db->QueryPrepare('_Passwords', $command, 'sii', [$args['category'], $args['id'], $user->ID]);
                if ($result === false) return 'error';
                return 'ok';
    
            case 'remove':
                $passwordIsCorrect = CheckPassword($db, $user->ID, $args['password']);
                if ($passwordIsCorrect === null) return 'error';
                if ($passwordIsCorrect === false) return 'wrong';
    
                $command = 'DELETE FROM TABLE WHERE `ID` = ? AND `UID` = ?';
                $result = $db->QueryPrepare('_Passwords', $command, 'ii', [$args['id'], $user->ID]);
                if ($result === false) return 'error';
                return 'ok';
        }
    };

    $passwords = array();
    $rawPasswords = $db->QueryPrepare('_Passwords', 'SELECT * FROM TABLE WHERE `UID` = ? ORDER BY Category ASC', 'i', [$user->ID]);
    foreach ($rawPasswords as $password) {
        $category = $password['Category'];
        if (!array_key_exists($category, $passwords)) {
            $passwords[$category] = array();
        }
        $Content = $db->encryption->Decrypt($password['Content'], $user->hashedPassword);
        $variables = json_decode($Content, true);
        $arr = array(
            $password['ID'],
            ucfirst($variables['service']),
            $variables['username'],
            $variables['status'],
            strlen($variables['password']) > 0
        );
        array_push($passwords[$category], $arr);
    }

    $categories = array_keys($passwords);
    $categoriesOptions = array_map(fn($c) => "<option value='$c'>$c</option>", $categories);
    $categoriesOptions = implode('', $categoriesOptions);

    $tables = '';
    foreach ($passwords as $category => $rows) {
        array_sort_by_column($rows, 1);
        $tableContent = '';
        $statusOrder = array('enable', 'none', 'disable');
        foreach ($statusOrder as $stat) {
            foreach ($rows as $row) {
                if ($row[3] === $stat) {
                    $tableContent .= AddRow(...$row);
                }
            }
        }
        $tables .= AddCard($category, $tableContent);
    }

    $variables = array(
        'username' => $user->Username,
        'passwords' => $tables
    );
    $popupVars = array(
        'categories' => $categoriesOptions
    );

    $content = ImportHTML(__DIR__.'/popups.html', $popupVars);
    $content .= ImportHTML(__DIR__.'/index.html', $variables);
    return $content;

?>