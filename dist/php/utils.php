<?php

    function StartsWith($haystack, $needle) {
        $length = strlen($needle);
        return substr($haystack, 0, $length) === $needle;
    }

    function EndsWith($haystack, $needle) {
        $length = strlen($needle);
        return !$length || substr($haystack, -$length) === $needle;
    }

    /**
     * @param string $path Path of the parent directory to search in recursively
     * @param string $extension Extension of the files to get
     * @return array List of files with the given extension
     */
    function GetScriptsFiles($path, $extension) {
        $files = array();
        if ($dir = opendir($path)) {
            while ($file = readdir($dir)) {
                if (is_dir($path . $file) && $file !== '.' && $file !== '..') {
                    $files = array_merge($files, GetScriptsFiles($path . $file . '/', $extension));
                }
                if (EndsWith($file, $extension)) {
                    $files[] = $path . $file;
                }
            }
            closedir($dir);
        }
        return $files;
    }

    /**
     * @param string $path The path of the HTML file to load
     * @param array $variables Keys are variables name between % and % in html file
     * @return string The HTML file content with variables replaced
     */
    function ImportHTML($path, $variables) {
        $html = file_get_contents($path);
        foreach ($variables as $key => $value) {
            $html = str_replace('%' . $key . '%', $value, $html);
        }
        return $html;
    }

    function GetScriptsImports($script) {
        $extension = pathinfo($script, PATHINFO_EXTENSION);
        if ($extension === 'js') {
            return "<script src=\"$script\"></script>";
        } else if ($extension === 'css') {
            return "<link rel=\"stylesheet\" href=\"$script\">";
        }
        return '';
    }

    function GetIP() {
        if (isset($_SERVER['HTTP_CLIENT_IP']))
            return $_SERVER['HTTP_CLIENT_IP'];
        elseif (isset($_SERVER['HTTP_X_FORWARDED_FOR']))
            return $_SERVER['HTTP_X_FORWARDED_FOR'];
        else
            return (isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '');
    }

    /**
     * Return number of characters at the beginning of a string
     * @param string $str
     * @param string $char One character
     * @return int
     */
    function str_count_first($str, $char) {
        for ($i = 0; $i < strlen($str); $i++) {
            if ($str[$i] !== $char) {
                return $i;
            }
        }
        return 0;
    }

    /**
     * Same as str_replace but replace only the first occurence
     * @param string $search
     * @param string $replace
     * @param string $subject
     * @return string
     */
    function str_replace_first($search, $replace, $subject) {
        $pos = strpos($subject, $search);
        if ($pos === false) {
            return $subject;
        }
        return substr_replace($subject, $replace, $pos, strlen($search));
    }

?>