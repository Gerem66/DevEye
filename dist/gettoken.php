<?php

    /**
     * Initial file name: getip.php
     * But renamed gettoken.php to confuse the issue
     */

    function GetIP() {
        if (isset($_SERVER['HTTP_CLIENT_IP']))
            return $_SERVER['HTTP_CLIENT_IP'];
        elseif (isset($_SERVER['HTTP_X_FORWARDED_FOR']))
            return $_SERVER['HTTP_X_FORWARDED_FOR'];
        else
            return (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '');
    }

    $IP = GetIP();
    $IP .= '-';
    $IP .= bin2hex(openssl_random_pseudo_bytes(4));

    $encryptIP = openssl_encrypt($IP, 'AES-128-ECB', 's5/vZ2G9~f9(p]w_');;
    echo($encryptIP);

?>