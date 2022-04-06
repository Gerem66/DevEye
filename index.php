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
        
        <!-- Icon   --><link rel="icon" href="dist/img/Oxy.png">
        <!-- Style  --><link rel="stylesheet" href="dist/css/login.css">
        <!-- Icons  --><link rel="stylesheet" href="dist/css/icons.css">
        <!-- Inputs --><link rel="stylesheet" href="dist/css/inputs.css">
        <!-- Script --><script src="dist/js/login.js"></script>
    </head>

    <body>
        <div class="form">
            <span class="title"><b>Oxy</b> Gestion</span>
            <form class="card" action="./accueil" method="post">
                <!--p class="login-box-msg">Phrase ?</p-->
                <div class="input-group">
                    <input type="text" class="form-input <?= $is_valid_txt ?>" placeholder="Nom d'utilisateur" name="tb_name" required>
                    <span class="icon icon-user"></span>
                </div>
                <div class="input-group">
                    <input type="password" class="form-input <?= $is_valid_txt ?>" placeholder="Mot de passe" name="tb_pass" required>
                    <span class="icon icon-lock"></span>
                </div>
                <button type="submit" class="submit" name="bt_connect">Se connecter</button>
            </form>
        </div>
    </body>
</html>