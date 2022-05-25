<?php

    /**
     * @var User $user
     * @var DataBase $db
     */

    require(__DIR__.'/utils.php');

    switch ($post['action']) {
        case 'add':
            $success = AddPassword($db, $user->ID, $post['category'],
                $post['service'], $post['username'],
                $post['password'], $post['status']);
    
            if (!$success) {
                exit('{"status": "error"}');
            }
            exit('{"status": "ok"}');

        case 'show':
            // Check user password
            $u = $db->QueryPrepare('Users', 'SELECT * FROM TABLE WHERE `ID` = ?', 'i', [$user->ID]);
            if ($u === false || count($u) === 0) exit('{"status": "error"}');
            if (!password_verify($post['password'], $u[0]['Password'])) exit('{"status": "wrong"}');

            // Get password
            $result = $db->QueryPrepare('_Passwords', 'SELECT `Content` FROM TABLE WHERE `ID` = ? AND `UID` = ?', 'ii', [$post['id'], $user->ID]);
            if ($result === false || count($result) === 0) exit('{"status": "error"}');
            $content = json_decode($db->Decrypt($result[0]['Content']), true);
            $status = array('status' => 'ok', 'content' => $content['password']);
            exit(json_encode($status));

        case 'categoryEdit':
            $command = 'UPDATE TABLE SET `Category` = ? WHERE `Category` = ? AND `UID` = ?';
            $result = $db->QueryPrepare('_Passwords', $command, 'ssi', [$post['new'], $post['old'], $user->ID]);
            if ($result === false) exit('{"status": "error"}');
            exit('{"status": "ok"}');
    }

    $passwords = array();
    $rawPasswords = $db->QueryPrepare('_Passwords', 'SELECT * FROM TABLE WHERE `UID` = ? ORDER BY Category ASC', 'i', [$user->ID]);
    foreach ($rawPasswords as $password) {
        $category = $password['Category'];
        if (!array_key_exists($category, $passwords)) {
            $passwords[$category] = array();
        }
        $Content = $db->Decrypt($password['Content']);
        $variables = json_decode($Content, true);
        $arr = array($password['ID'], $variables['service'], $variables['username'], $variables['status']);
        array_push($passwords[$category], $arr);
    }

    $categories = array_keys($passwords);
    $categoriesOptions = array_map(fn($c) => "<option value='$c'>$c</option>", $categories);
    $categoriesOptions = implode('', $categoriesOptions);

    $tables = '';
    foreach ($passwords as $category => $rows) {
        array_sort_by_column($rows, 1);
        $tableContent = '';
        foreach ($rows as $row) {
            $tableContent .= AddRow(...$row);
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
    echo($content);

?>