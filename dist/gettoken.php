<?php

    /**
     * Initial file name: getip.php
     * But renamed gettoken.php to confuse the issue
     */

    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST');
    header("Access-Control-Allow-Headers: X-Requested-With");

    /**
     * Return IP address of the client
     * @return string|null
     */
    function GetIP() {
        function checkIP($ip) { return filter_var($ip, FILTER_VALIDATE_IP); }
        $ip = null;
        $keys = array('REMOTE_ADDR', 'HTTP_X_FORWARDED_FOR', 'HTTP_CLIENT_IP');
        foreach ($keys as $key) {
            if (checkIP(@$_SERVER[$key])) {
                $ip = $_SERVER[$key];
            }
        }
        return $ip;
    }

    $key = '3TA3,<jbr?S4';
    if (!array_key_exists('key', $_POST) || $_POST['key'] !== $key) {
        http_response_code(404);
        exit();
    }

    $IP = GetIP();
    $IP .= '-';
    $IP .= bin2hex(openssl_random_pseudo_bytes(4));
    $encryptIP = openssl_encrypt($IP, 'AES-128-ECB', 's5/vZ2G9~f9(p]w_');;
    echo($encryptIP);

?>