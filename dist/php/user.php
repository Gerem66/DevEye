<?php

    /**
     * User connection from login page (POST)
     * @param DataBase $db
     * @param string $username
     * @param string $password
     * @return bool True if the user is connected, false otherwise
     */
    function Connect($db, $username, $password) {
        if (!isset($username, $password)) {
            return false;
        }

        $reqUser = $db->GetRowContent('Users', 'Username', $username);
        $user = User::Load($reqUser);

        if ($user === null) {
            $db->AddLog(0, 'login', "User connection failed - User \"$username\" not found");
            return false;
        }

        if (!password_verify($password, $user->Password)) {
            $db->AddLog($user->ID, 'login', 'User connection failed - wrong password');
            return false;
        }

        $db->AddLog($user->ID, 'login', 'User connection successfully.');
        return true;
    }

?>