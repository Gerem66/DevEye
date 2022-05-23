<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require('../dist/php/class/feature.php');
    require('../dist/php/class/instance.php');
    require('../dist/php/class/project.php');
    require('../dist/php/class/user.php');

    require('../dist/php/components/dbtable.php');
    require('../dist/php/components/markdown.php');

    require('../dist/php/sql/sql.php');
    require('../dist/php/roles.php');
    require('../dist/php/utils.php');

    // Check user state
    if (!isset($_SESSION['USER_ID'])) {
        // Hack try suspicion (or automatic disconnect)
        die('disconnect');
    }

    $db = new DataBase();
    $rawUser = $db->GetRowContent('Users', 'ID', $_SESSION['USER_ID']);
    $user = User::Load($rawUser);

    $input = file_get_contents('php://input');
    $post = json_decode($input, true);

    $page = isset($_GET['page']) ? $_GET['page'] : '';

    if ((is_dir("./$page/") && is_file("./$page/index.php"))) {
        require("./$page/index.php");
        $js = file_get_contents("./$page/main.js");
        echo("<script>$js</script>");
    }

?>