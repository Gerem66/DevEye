<?php

    function GetIP() {
        if (isset($_SERVER['HTTP_CLIENT_IP']))
            return $_SERVER['HTTP_CLIENT_IP'];
        elseif (isset($_SERVER['HTTP_X_FORWARDED_FOR']))
            return $_SERVER['HTTP_X_FORWARDED_FOR'];
        else
            return (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '');
    }

    $IP = GetIP();
    $encryptIP = openssl_encrypt($IP, 'AES-128-ECB', 's5/vZ2G9~f9(p]w_');;
    echo($encryptIP);

?>