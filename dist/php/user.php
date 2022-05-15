<?php

    /**
     * User connection from login page (POST)
     * @param DataBase $db
     * @return bool True if the user is connected, false otherwise
     */
    function Connect($db) {
        $username = $_POST['tb_name'];
        $password = $_POST['tb_pass'];

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

        $_SESSION['USER_ID'] = $user->ID;
        $db->AddLog($user->ID, 'login', 'User connection successfully.');
        return true;
    }

    function Disconnect() {
        unset($_SESSION['CONNECTED']);
        unset($_SESSION['USER_ID']);
    }

?>