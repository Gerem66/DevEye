<?php

    $is_valid_txt = '';
    $hash = '';

    if (isset($_POST['bt_connect'], $_POST['tb_pass'], $_POST['tb_pass2'])) {
        $pwd1 = $_POST['tb_pass'];
        $pwd2 = $_POST['tb_pass2'];
        if ($pwd1 !== $pwd2) {
            $is_valid_txt = 'is-invalid';
        } else {
            $hash = password_hash($pwd1, PASSWORD_BCRYPT);
        }
    }

    $hide_pwd = $hash === '' ? '' : 'style="display: none;"';
    $hide_hash = $hash !== '' ? '' : 'style="display: none;"';

?>

<!DOCTYPE html>
<html lang="fr">
    <head>
        <meta charset="utf-8">
        <title>Oxy Gestion - Encryptor</title>
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
        <!-- Prevent Resubmission Alert   --><script src="dist/js/clipboard.js"></script>
    </head>

    <body class="hold-transition login-page">
        <div class="background"></div>
        <div class="login-box">
            <div class="login-logo">
                <a style="color: #ccc; user-select: none; cursor: initial;"><b>Oxy</b> Encryptor</a>
            </div>
            <div class="card">
                <div class="card-body login-card-body">

                    <form action="./encryptor" method="post" <?= $hide_pwd ?>>
                        <div class="input-group mb-3">
                            <input type="password" class="form-control <?= $is_valid_txt ?>" placeholder="Mot de passe" name="tb_pass" required>
                            <div class="input-group-append">
                                <div class="input-group-text">
                                    <span class="fas fa-lock"></span>
                                </div>
                            </div>
                        </div>
                        <div class="input-group mb-3">
                            <input type="password" class="form-control <?= $is_valid_txt ?>" placeholder="Mot de passe encore" name="tb_pass2" required>
                            <div class="input-group-append">
                                <div class="input-group-text">
                                    <span class="fas fa-lock"></span>
                                </div>
                            </div>
                        </div>
                        <div class="col-16">
                            <button type="submit" class="btn btn-primary btn-block" name="bt_connect">Chiffrer (bcrypt)</button>
                        </div>
                    </form>

                    <div <?= $hide_hash ?>>
                        <div class="input-group mb-3">
                            <input class="form-control" name="tb_pass" value="<?= $hash ?>" readonly>
                            <div class="input-group-append">
                                <div class="input-group-text">
                                    <span class="fas fa-lock"></span>
                                </div>
                            </div>
                        </div>
                        <div class="col-16">
                            <button type="submit" class="btn btn-primary btn-block" name="bt_connect" onclick="CopyContent('<?= $hash ?>')">Copier & retour</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </body>
</html>