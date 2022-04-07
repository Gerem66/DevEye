<?php

    $hash = '';
    $class_error = '';

    if (isset($_POST['bt_connect'], $_POST['tb_pass'], $_POST['tb_pass2'])) {
        $pwd1 = $_POST['tb_pass'];
        $pwd2 = $_POST['tb_pass2'];
        if ($pwd1 !== $pwd2) {
            $class_error = 'error';
        } else {
            $hash = password_hash($pwd1, PASSWORD_BCRYPT);
        }
    }

    $class_pwd = $hash === '' ? '' : 'style="display: none;"';
    $class_hash = $hash !== '' ? '' : 'style="display: none;"';

    $content = file_get_contents('./encryptor.html');
    $content = str_replace('%hash%', $hash, $content);
    $content = str_replace('%class_pwd%', $class_pwd, $content);
    $content = str_replace('%class_hash%', $class_hash, $content);
    $content = str_replace('%class_error%', $class_error, $content);
    echo($content);

?>