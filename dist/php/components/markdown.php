<?php

    /**
     * @param string $line
     */
    function ExecuteMd($line) {
        $l = trim($line);
        // Underline
        while (substr_count($l, '__') >= 2) {
            $l = str_replace_first('__', '<u>', $l);
            $l = str_replace_first('__', '</u>', $l);
        }
        // Line-through
        while (substr_count($l, '--') >= 2) {
            $l = str_replace_first('--', '<s>', $l);
            $l = str_replace_first('--', '</s>', $l);
        }
        // Bold
        while (substr_count($l, '**') >= 2) {
            $l = str_replace_first('**', '<b>', $l);
            $l = str_replace_first('**', '</b>', $l);
        }
        // Italic
        while (substr_count($l, '*') >= 2) {
            $l = str_replace_first('*', '<i>', $l);
            $l = str_replace_first('*', '</i>', $l);
        }
        // Icons
        $l = str_replace('-->', '<i class="icon icon-arrow"></i>', $l);
        $l = str_replace('->', '<i class="icon icon-arrow"></i>', $l);
        return $l;
    }

    /**
     * @param string $lines
     */
    function TextMdToHtml($lines) {
        $content = '';
        if (!$lines) {
            return $content;
        }
        $lines = explode("\n", $lines);
        $lines = array_map('trim', $lines);

        $squareIndex = 0;
        $inList = array();

        $compList = array(
            '#' => 'h1',
            '##' => 'h2',
            '###' => 'h3',
            '####' => 'h4',
            '#####' => 'h5',
            '######' => 'h6',
            '*' => 'ul',
            '-' => 'ul',
            '+' => 'ol'
        );
        $compCheckbox = array(
            '[x]' => 'checked',
            '[v]' => 'checked',
            '[]' => 'empty',
            '[ ]' => 'empty'
        );

        foreach ($lines as $line) {
            $l = $line;
            $type = 'p';
            foreach ($compList as $key => $value) {
                if (StartsWith($line, $key)) {
                    $type = $value;
                    $l = substr($line, strlen($key));
                }
            }
            $l = ExecuteMd($l);

            if (count($inList) && $type !== 'ul' && $type !== 'ol') {
                while (count($inList)) {
                    // Remove last level (list & content)
                    $lastLevel = array_splice($inList, -1, 1)[0];
                    $content .= "</$lastLevel>";
                }
            }

            switch ($type) {
                case 'h1':
                case 'h2':
                case 'h3':
                case 'h4':
                case 'h5':
                case 'h6':
                    $content .= "<$type>{$l}</$type>";
                    break;

                case 'ul':
                case 'ol':
                    $newLevel = str_count_first($line, $line[0]);
                    while (($currLevel = count($inList)) !== $newLevel) {
                        if ($currLevel > $newLevel) {
                            // Remove last level (list & content)
                            $lastLevel = array_splice($inList, -1, 1)[0];
                            $content .= "</$lastLevel>";
                        } else {
                            // Add new level (list & content)
                            $content .= "<$type>";
                            array_push($inList, $type);
                        }
                    }
                    $l = substr($l, $newLevel - 1);
                    $l = trim($l);

                    if (($pos = strpos($l, ']')) !== false) {
                        $textCheckbox = substr($l, 0, $pos + 1);
                        if (array_key_exists($textCheckbox, $compCheckbox)) {
                            $checked = $compCheckbox[$textCheckbox] === 'checked';
                            $icon = $checked ? 'check' : 'empty';
                            $state = $checked ? 'checked' : '';
                            $checkbox = "<i name='checkable' class='icon icon-square-$icon' data-id='$squareIndex' $state></i>";
                            $l = $checkbox . substr($l, $pos + 1);
                            $squareIndex++;
                        }
                        $content .= "<li class='checkable'>{$l}</li>";
                        break;
                    }

                    $content .= "<li>{$l}</li>";
                    break;

                case 'p':
                default:
                    $content .= "<p>{$l}</p>";
                    break;
            }
        }

        return $content;
    }

?>