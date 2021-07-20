<?php

    $grades = [ "Invité", "Utilisateur", "Modérateur", "Développeur" ];

    $username   = $_SESSION['USERNAME'];
    $email      = $_SESSION['EMAIL'];
    $email_ok   = $_SESSION['EMAIL_VALIDE'];
    $avatar     = $_SESSION['PHOTO'];
    $status     = $_SESSION['STATUS'];
    $instance   = $_SESSION['INSTANCE'];
    $reg_date   = $_SESSION['INSCRIPTION_DATE'];

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
                                <!--li class="list-group-item">
                                    <b>Mot de passe</b><button class="btn btn-block btn-primary btn-xs float-right" style="width: 182px; display: inline;">/!\ Modifier le mot de passe</button>
                                </li-->
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