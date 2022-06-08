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
     * @param array $ignore, list of filenames to ignore
     * @return string All content of the files
     */
    function GetScriptsFiles($path, $extension, $ignore = array()) {
        $content = '';
        if (substr($path, -1) != '/') $path .= '/';
        if ($dir = opendir($path)) {
            while ($filename = readdir($dir)) {
                if (is_dir($path . $filename) && $filename !== '.' && $filename !== '..') {
                    $content .= GetScriptsFiles($path . $filename, $extension, $ignore);
                }

                $ignore_match = false;
                foreach ($ignore as $ignore_filename) {
                    if ($filename === "$ignore_filename.$extension") {
                        $ignore_match = true;
                        break;
                    }
                }

                if (EndsWith($filename, ".$extension") && !$ignore_match) {
                    $content .= file_get_contents($path . $filename) . "\n";
                }
            }
            closedir($dir);
        }
        return $content;
    }

    /**
     * @param string $path The path of the HTML file to load
     * @param array $variables Keys are variables name between % and % in html file
     * @return string The HTML file content with variables replaced
     */
    function ImportHTML($path, $variables = array()) {
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

    function array_sort_by_column(&$arr, $col, $dir = SORT_ASC) {
        $sort_col = array();
        foreach ($arr as $key => $row) {
            $sort_col[$key] = $row[$col];
        }
        array_multisort($sort_col, $dir, $arr);
    }

    /**
     * @param array $arr1
     * @param array $arr2
     * @return bool True if concatenation successfully, false otherwise
     */
    function array_concatenate(&$arr1, $arr2) {
        foreach ($arr2 as $key => $value) {
            if (key_exists($key, $arr1)) {
                $type = gettype($arr1[$key]);
                if ($type !== gettype($value)) {
                    continue;
                }
                if ($type === 'array') {
                    array_concatenate($arr1[$key], $value);
                } else if ($type === 'integer') {
                    $arr1[$key] = $value;
                } else if ($type === 'string') {
                    $arr1[$key] = $arr1[$key] . $value;
                }
            } else {
                $arr1[$key] = $value;
            }
        }
    }

?>