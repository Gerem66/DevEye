<?php

    session_start();
    require("dist/php/user.php");
    require("dist/php/bdd.php");

    // Disconnect
    if (isset($_REQUEST['disconnect'])) {
        Disconnect();
    }

    // Already connected
    if (isset($_SESSION['STATUS'], $_SESSION['CONNECTED']) && $_SESSION['STATUS'] >= 0 && $_SESSION['STATUS'] <= 3 && $_SESSION['CONNECTED'] >= 0) {
        header('Location: ./accueil');
        exit();
    }

    // Authentication failed
    if (!isset($_SESSION['CONNECTED'])) $_SESSION['CONNECTED'] = 0;
    $is_valid_txt = $_SESSION['CONNECTED'] == -1 ? 'is-invalid' : '';
    if ($_SESSION['CONNECTED'] < 0) $_SESSION['CONNECTED'] = 0;

?>

<!DOCTYPE html>
<html lang="fr">
    <head>
        <meta charset="utf-8">
        <title>Oxy Gestion - Connexion</title>
		<meta http-equiv="X-UA-Compatible" content="IE=edge">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<meta name="author" content="Geremy">
		<meta name="description" content="Oxy Foo">
        <meta name="robots" content="noindex">
        <meta name="googlebot" content="noindex">
        
        <!-- Icon                         --><link rel="icon" href="dist/img/Oxy.png">
        <!-- Font Awesome                 --><link rel="stylesheet" href="plugins/fontawesome-free/css/all.min.css">
        <!-- Ionicons                     --><link rel="stylesheet" href="https://code.ionicframework.com/ionicons/2.0.1/css/ionicons.min.css">
        <!-- icheck bootstrap             --><link rel="stylesheet" href="plugins/icheck-bootstrap/icheck-bootstrap.min.css">
        <!-- Theme style                  --><link rel="stylesheet" href="dist/css/adminlte.css">
        <!-- Background                   --><link rel="stylesheet" href="dist/css/background.css">
        <!-- Google Font: Source Sans Pro --><link href="https://fonts.googleapis.com/css?family=Source+Sans+Pro:300,400,400i,700" rel="stylesheet">
        <!-- Prevent Resubmission Alert   --><script src="dist/js/prevent_resubmission_alert.js"></script>
    </head>

    <body class="hold-transition login-page">
        <div class="background"></div>
        <div class="login-box">
            <div class="login-logo">
                <a style="color: #ccc; user-select: none; cursor: initial;"><b>Oxy</b> Gestion</a>
            </div>
            <div class="card">
                <div class="card-body login-card-body">
                    <!--p class="login-box-msg">Connectez-vous ou continuez en tant qu'invité</p-->

                    <form action="./accueil" method="post">
                        <div class="input-group mb-3">
                            <input type="text" class="form-control <?= $is_valid_txt ?>" placeholder="Nom d'utilisateur" name="tb_name" required>
                            <div class="input-group-append">
                                <div class="input-group-text">
                                    <span class="fas fa-user"></span>
                                </div>
                            </div>
                        </div>
                        <div class="input-group mb-3">
                            <input type="password" class="form-control <?= $is_valid_txt ?>" placeholder="Mot de passe" name="tb_pass" required>
                            <div class="input-group-append">
                                <div class="input-group-text">
                                    <span class="fas fa-lock"></span>
                                </div>
                            </div>
                        </div>
                        <div class="col-16">
                            <button type="submit" class="btn btn-primary btn-block" name="bt_connect">Se connecter</button>
                        </div>
                    </form>

                    <!--form action="./accueil" method="post">
                        <div class="social-auth-links text-center mb-3">
                            <p>- OU -</p>
                            <button class="btn btn-block btn-primary" type="submit" name="bt_guest">
                                <i class="fas fa-user mr-2"></i> Continuer en tant qu'invité
                            </button>
                        </div>
                    </form-->
                </div>
            </div>
        </div>
    </body>
</html>