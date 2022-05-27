<?php

    /**
     * @var User $user
     * @var DataBase $db
     */

    require(__DIR__.'/utils.php');

    switch ($post['action']) {
        case 'add':
            $content = GetPasswordContent($db, $post['service'], $post['username'], $post['password'], $post['status']);
            $success = AddPassword($db, $user->ID, $post['category'], $content);
            if (!$success) exit('{"status": "error"}');
            exit('{"status": "ok"}');

        case 'getPassword':
            $passwordIsCorrect = CheckPassword($db, $user->ID, $post['password']);
            if ($passwordIsCorrect === null) exit('{"status": "error"}');
            if ($passwordIsCorrect === false) exit('{"status": "wrong"}');

            // Get password
            $result = $db->QueryPrepare('_Passwords', 'SELECT `Content` FROM TABLE WHERE `ID` = ? AND `UID` = ?', 'ii', [$post['id'], $user->ID]);
            if ($result === false || count($result) === 0) exit('{"status": "error"}');
            $content = json_decode($db->Decrypt($result[0]['Content']), true);
            $status = array('status' => 'ok', 'content' => $content);
            exit(json_encode($status));

        case 'categoryEdit':
            $command = 'UPDATE TABLE SET `Category` = ? WHERE `Category` = ? AND `UID` = ?';
            $result = $db->QueryPrepare('_Passwords', $command, 'ssi', [$post['new'], $post['old'], $user->ID]);
            if ($result === false) exit('{"status": "error"}');
            exit('{"status": "ok"}');

        case 'edit':
            $content = GetPasswordContent($db, $post['service'], $post['username'], $post['password'], $post['status']);
            $success = EditPassword($db, $user->ID, $post['id'], $post['category'], $content);
            if (!$success) exit('{"status": "error"}');
            exit('{"status": "ok"}');

        case 'move':
            $command = 'UPDATE TABLE SET `Category` = ? WHERE `ID` = ? AND `UID` = ?';
            $result = $db->QueryPrepare('_Passwords', $command, 'sii', [$post['category'], $post['id'], $user->ID]);
            if ($result === false) exit('{"status": "error"}');
            exit('{"status": "ok"}');

        case 'remove':
            $passwordIsCorrect = CheckPassword($db, $user->ID, $post['password']);
            if ($passwordIsCorrect === null) exit('{"status": "error"}');
            if ($passwordIsCorrect === false) exit('{"status": "wrong"}');

            $command = 'DELETE FROM TABLE WHERE `ID` = ? AND `UID` = ?';
            $result = $db->QueryPrepare('_Passwords', $command, 'ii', [$post['id'], $user->ID]);
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
        $arr = array($password['ID'], ucfirst($variables['service']), $variables['username'], $variables['status'], strlen($variables['password']) > 0);
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
    echo($content);

?>