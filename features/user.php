<?php

    $grades = [ "Invité", "Utilisateur", "Modérateur", "Développeur" ];

    $username   = $_SESSION['USERNAME'];
    $email      = $_SESSION['EMAIL'];
    $email_ok   = $_SESSION['EMAIL_VALIDE'];
    $avatar     = $_SESSION['PHOTO'];
    $status     = $_SESSION['STATUS'];
    $instance   = $_SESSION['INSTANCE'];
    $reg_date   = $_SESSION['INSCRIPTION_DATE'];

    if (isset($_POST['quicklink'])) {
        $_status = "OK";
        $password = $_POST['quicklink'];

        // Check password validity
        $db = new DataBase;
        $req_user = $db->GetRowContent('Users', 'Username', $username);
        if (isset($req_user)) {
            if (password_verify($password, $req_user['Password'])) {
                AddLog($_SESSION['ID'], "Quicklink generated.");
                $encrypt_password = base64_encode($db->Encrypt(GetIP() . "\t" . $password));
                $link = "https://geremy.eu/Oxy?login=$username&pwd=$encrypt_password";
            } else {
                AddLog($_SESSION['ID'], "Quicklink generation failed !");
                $_status = "FAIL";
                $link = "Wrong password";
            }
        }

        // Return quicklink
        echo("$_status\n$link");
        exit();
    }

    // Get instance length
    $db = new DataBase;
    $instance_length = 0;
    $instanceID = $_SESSION['INSTANCE_ID'];
    $result = $db->query("SELECT ID FROM `Users` WHERE `InstanceID` = '$instanceID'");
    if (isset($result)) {
        $instance_length = $result->num_rows;
    }
    
    $icon_ok = '<i class="fas fa-check-circle" style="color: green; margin-left: 6px;"></i>';
    $icon_ko = '<i class="fas fa-times-circle" style="color: red; margin-left: 6px;"></i>';
    $status_txt = $grades[$status];
    $instance_txt = "$instance ($instance_length membre" . ($instance_length > 1 ? 's)' : ')');
    $mailIcon = $email_ok ? $icon_ok : $icon_ko;

?>

<section id="popup-quicklink" class="kb-popup content-wrapper">
    <div class="popup-card">
        <h1 id="box-title">Entre ton mot de passe</h1>
        <p>Pour récupérer un lien de connexion rapide</p>
        <br />
        <div class="col-6 card-center">
            <div class="input-group">
                <input name="pwd" type="password" class="form-control" placeholder="Mot de passe" value="<?= $password ?>">
                <div class="input-group-prepend">
                    <button type="button" class="btn bg-primary" onclick="SwitchPasswordVision(this);" style="border-top-right-radius: 0.25rem; border-bottom-right-radius: 0.25rem; padding: 0; width: 34px"><i class="far fa-eye-slash"></i></button>
                </div>
            </div>
        </div>
        <br />
        <div class="col-6 card-center">
            <button name="back" class="btn btn-dark btn-lg" style="width: 196px; margin: 24px 12px 0;">Retour</button>
            <button name="save" class="btn bg-primary btn-lg" style="width: 196px; margin: 24px 12px 0;">Enregistrer</button>
        </div>
    </div>
</section>

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
                <div class="col-md-4" style="margin-left: auto; margin-right: auto;">

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
                                    <b>Instance</b><a class="float-right nolink"><?= $instance_txt ?></a>
                                </li>
                                <li class="list-group-item">
                                    <b>Adresse Email</b>
                                    <a class="float-right nolink">
                                        <?= $email.$mailIcon ?>
                                    </a>
                                </li>
                                <li class="list-group-item">
                                    <b>Mot de passe</b>
                                    <button class="btn btn-block btn-primary btn-xs float-right" style="width: 160px;">[Modifier le mot de passe]</button>
                                    <button class="btn btn-block btn-primary btn-xs float-right" style="width: 100px; margin: 0 12px 0 0;" onclick="OpenQuicklinkPopup()">Lien rapide</button>
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