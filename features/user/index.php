<?php

    $grades = [ "Invité", "Utilisateur", "Modérateur", "Admin" ];

    $username   = $_SESSION['USERNAME'];
    $email      = $_SESSION['EMAIL'];
    $email_ok   = $_SESSION['EMAIL_VALIDE'];
    $avatar     = $_SESSION['PHOTO'];
    $status     = $_SESSION['STATUS'];
    $instance   = $_SESSION['INSTANCE'];
    $instanceID = $_SESSION['INSTANCE_ID'];
    $reg_date   = $_SESSION['INSCRIPTION_DATE'];

    if (isset($_POST['changepassword'], $_POST['newpassword'])) {
        $_status = "FAIL";
        $password = $_POST['changepassword'];
        $password_new = $_POST['newpassword'];

        // Check password validity
        $db = new DataBase;
        $req_user = $db->GetRowContent('Users', 'Username', $username);
        if (isset($req_user)) {
            if (password_verify($password, $req_user['Password'])) {
                $hash = password_hash($password_new, PASSWORD_BCRYPT);
                $db->SetCellContent('Users', 'Password', $req_user['ID'], $hash, false);
                AddLog($_SESSION['ID'], "Password changed successfully.");
                $_status = "OK";
            } else {
                AddLog($_SESSION['ID'], "Password changing failed (wrong password) !");
                $_status = "WRONG";
            }
        }

        echo($_status);
        exit();
    }

    // Get instance length
    if ($instanceID > 0) {
        $db = new DataBase;
        $instance_length = 0;
        $result = $db->Query("SELECT ID FROM `Users` WHERE `InstanceID` = '$instanceID'");
        if (isset($result)) {
            $instance_length = $result->num_rows;
        }
        $instance .= " ($instance_length membre" . ($instance_length > 1 ? 's)' : ')');
    }
    
    $icon_ok = '<i class="fas fa-check-circle" style="color: green; margin-left: 6px;"></i>';
    $icon_ko = '<i class="fas fa-times-circle" style="color: red; margin-left: 6px;"></i>';
    $status_txt = $grades[$status];
    $mailIcon = $email_ok ? $icon_ok : $icon_ko;

?>

<!-- Popup - Change password -->
<!--section id="popup-changepwd" class="kb-popup content-wrapper">
    <div class="popup-card">
        <h1 id="box-title">Changer ton mot de passe</h1>
        <p>Aucune limitation, donc soit sûr de la sécurité de ton mot de passe<br />
        Conseillé : 12 caractères minimum, avec minuscules/majuscules/chiffres et caractères spéciaux</p>
        <br />
        <div class="col-6 card-center">
            <div class="input-group">
                <input name="pwd" type="password" class="form-control" placeholder="Ancien mot de passe">
                <div class="input-group-prepend">
                    <button name="bt-show-password" type="button" class="btn bg-primary btn-vision"><i class="far fa-eye-slash"></i></button>
                </div>
            </div>
        </div>
        <br />
        <div class="col-6 card-center">
            <div class="input-group">
                <input name="new-pwd" type="password" class="form-control" placeholder="Nouveau mot de passe">
                <div class="input-group-prepend">
                    <button name="bt-show-password" type="button" class="btn bg-primary btn-vision"><i class="far fa-eye-slash"></i></button>
                </div>
            </div>
        </div>
        <br />
        <div class="col-6 card-center">
            <button name="back" class="btn btn-dark btn-lg btn-popup">Retour</button>
            <button name="save" class="btn bg-primary btn-lg btn-popup">Enregistrer</button>
        </div>
    </div>
</section-->

<!-- Main -->
<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Profil</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item active"><?= $username ?></li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">            
            <div class="row">
                <div class="col-md-4 card-center">

                    <!-- Profile Image -->
                    <div class="card card-primary card-outline">
                        <div class="card-body box-profile">
                            <div class="text-center">
                                <img class="profile-user-img img-fluid img-circle"
                                    src="dist/img/<?= $avatar ?>"
                                    alt="User profile picture">
                            </div>

                            <h3 class="profile-username text-center"><?= $username ?></h3>
                            <p class="text-muted text-center"><?= $status_txt ?></p>
                            <ul class="list-group list-group-unbordered mb-3">
                                <li class="list-group-item">
                                    <b>Niveau d'accès</b><a class="float-right nolink"><?= $status ?></a>
                                </li>
                                <li class="list-group-item">
                                    <b>Instance</b><a class="float-right nolink"><?= $instance ?></a>
                                </li>
                                <li class="list-group-item">
                                    <b>Adresse Email</b>
                                    <a class="float-right nolink">
                                        <?= $email.$mailIcon ?>
                                    </a>
                                </li>
                                <li class="list-group-item">
                                    <b>Mot de passe</b>
                                    <button id="bt-open-changepwd" class="btn btn-block btn-primary btn-xs float-right" style="width: 160px;">Modifier le mot de passe</button>
                                </li>
                                <li class="list-group-item">
                                    <b>Date de création du compte</b><a class="float-right nolink"><?= $reg_date ?></a>
                                </li>
                            </ul>
                            <form action="./" method="POST">
                                <button type="submit" name="disconnect" class="btn btn-primary btn-block"><b>Se déconnecter</b></button>
                            </form>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    </div>

</div>