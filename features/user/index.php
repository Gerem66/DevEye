<?php

    /** @var User $USER */

    $vars = array(
        'username' => $USER->Username,
        'email' => $USER->Email,
        'avatar' => $USER->Avatar,
        'instance' => 0,
        'date' => date('d/m/Y H:i', $USER->Created),
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
        $req_user = $db->GetRowContent('Users', 'ID', $USER->Username);
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