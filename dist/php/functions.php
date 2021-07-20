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

    function CheckPage($pageName) {
        $valid_pages = [ "user", "mails", "logbook", "logbook-edit", "passwords", "passwords-edit", "logs", "settings" ];
        $output = $pageName == 'user';
        if (!$output) {
            $features = $_SESSION['FEATURES'];
            for ($i = 0; $i < count($features); $i++) {
                if (startsWith($pageName, $features[$i]['page'])) {
                    $output = true;
                    break;
                }
            }
        }
        return $output;
    }

    function SettingsEnabled($settings_number, $settings_index) {
        return $settings_number == -1 || $settings_number & 1 << $settings_index;
    }

?>