<?php

    function startsWith($haystack, $needle) {
        $length = strlen($needle);
        return substr($haystack, 0, $length) === $needle;
    }

    function endsWith($haystack, $needle) {
        $length = strlen($needle);
        return !$length || substr($haystack, -$length) === $needle;
    }

    function GetPostValue($name, $defaut) {
        return isset($_REQUEST[$name]) ? $_REQUEST[$name] : $defaut;
    }

    function SettingsEnabled($settings_number, $settings_index) {
        return $settings_number == -1 || $settings_number & 1 << $settings_index;
    }

    function GetJavascriptFiles($path) {
        $files = array();
        if ($dir = opendir($path)) {
            while ($file = readdir($dir)) {
                if (is_dir($path . $file) && $file !== '.' && $file !== '..') {
                    $files = array_merge($files, GetJavascriptFiles($path . $file . '/'));
                }
                if (endsWith($file, '.js')) {
                    $files[] = $path . $file;
                }
            }
            closedir($dir);
        }
        return $files;
    }

    function AddLog($UID, $description) {
        $db = new DataBase();
        $IP = GetIP();
        $db->Query("INSERT INTO `Logs` (`UID`, `IP`, `Description`) VALUES ('$UID', '$IP', '$description')");
    }

    function GetIP() {
        if (isset($_SERVER['HTTP_CLIENT_IP']))
            return $_SERVER['HTTP_CLIENT_IP'];
        elseif (isset($_SERVER['HTTP_X_FORWARDED_FOR']))
            return $_SERVER['HTTP_X_FORWARDED_FOR'];
        else
            return (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '');
    }

?>