<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require('../dist/php/sql/sql.php');
    require('../dist/php/utils.php');

    // Check user state
    if (!isset($_SESSION['ID'])) {
        // Hack try suspicion (or automatic disconnect)
        die('disconnect');
    }

    $page = isset($_GET['page']) ? $_GET['page'] : '';
    $post_id = GetPostValue('id', 0);
    if ((is_dir("./$page/") && is_file("./$page/index.php"))) {
        require("./$page/index.php");
        $js = file_get_contents("./$page/main.js");
        echo("<script>$js</script>");
    }

?>