<?php

    function Connect() {
        $db = new DataBase;
        $username = $_POST['tb_name'];
        $password = $_POST['tb_pass'];
        $req_user = $db->GetRowContent('Users', 'Username', $username);
        if (isset($req_user)) {
            if (password_verify($password, $req_user['Password'])) {
                $instance = 'Aucune';
                $instanceID = $req_user['InstanceID'];
                if ($instanceID > 0) {
                    $instance = $db->GetCellContent('Instances', 'Name', $instanceID, false);
                }
                SetUser($req_user['ID'], $req_user['Username'],
                        date('d/m/y - H:i', strtotime($req_user['Created'])),
                        $req_user['Email'], $req_user['Level'],
                        $instanceID, $instance, $req_user['Avatar'],
                        $req_user['Settings'], $req_user['DefaultPage']);
                AddLog($_SESSION['ID'], "User connection successfully.");
                $connected = true;
            } else {
                AddLog($req_user['ID'], "User connection failed - wrong password");
            }
        }
    }

    function Disconnect() {
        unset($_SESSION['STATUS']);
        unset($_SESSION['USERNAME']);
        unset($_SESSION['CONNECTED']);
    }

    /**
     * int, string, string, string, bool, int, string, string
     */
    function SetUser($ID, $username, $inscription_date, $email, $status, $instanceID, $instance, $photo, $settings, $defaultPage) {
        $_SESSION['ID'] = $ID;
        $_SESSION['USERNAME'] = $username;
        $_SESSION['INSCRIPTION_DATE'] = $inscription_date;
        $_SESSION['EMAIL'] = $email;
        $_SESSION['EMAIL_VALIDE'] = $email != 'Aucune';
        $_SESSION['STATUS'] = $status;
        $_SESSION['INSTANCE_ID'] = $instanceID;
        $_SESSION['INSTANCE'] = $instance;
        $_SESSION['PHOTO'] = $photo;
        $_SESSION['SETTINGS'] = $settings;
        $_SESSION['DEFAULT_PAGE'] = $defaultPage;
    }

?>