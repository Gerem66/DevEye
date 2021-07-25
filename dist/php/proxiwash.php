<?php

    function AddLine($no = '', $state = '', $program = '', $progress = 0, $color = 'primary', $t_start = null, $t_end = null) {
        $time = ($t_start != null && $t_end != null) ? $time = "$t_start / $t_end" : "";
        $badge = ($progress > 0 && $color == 'success') ? "<span class='badge bg-$color'>$progress%</span>" : "";
        return "<tr>
                    <td>$no</td>
                    <td>$state</td>
                    <td>$program</td>
                    <td>
                        <div class='progress progress-xs' style='margin-top: 6px;'>
                            <div class='progress-bar progress-bar-primary bg-$color' style='width: $progress%'></div>
                        </div>
                    </td>
                    <td>$badge</td>
                    <td>$time</td>
                </tr>";
    }

    function HourStrToMinutesInt($hour_txt) {
        list($h, $m) = explode(':', $hour_txt);
        return intval($h) * 60 + intval($m);
    }

    function ParseMachines($content) {
        $lines = explode("\n", $content);
        
        // Get raw tables (washing machines)
        $raw_tables = "";
        for ($i = 0; $i < count($lines); $i++)
            if (strpos($lines[$i], 'id="liste-machines"'))
                $raw_tables .= htmlspecialchars($lines[$i]);

        // Replace HTML to string
        $chars_replace = array(
            '&lt;' => '<', '&gt;' => '>',
            '&amp;' => '&', '&nbsp;' => ' ',
            '&Eacute;' => 'É', '&eacute;' => 'é',
            '&quot;' => '"', '&frasl;' => '/',
            '<font>' => '', '</font>' => '',
            '<img>' => '', '</img>' => ''
        );
        foreach ($chars_replace as $key => $value)
            $raw_tables = str_replace($key, $value, $raw_tables);

        // Remove useless tags (class, style, etc)
        $inTag = false;             // eg : <HERE ...>...
        $afterSpace = false;        // eg : <div HERE ...>...
        $reduced_tables = "";
        for ($c = 0; $c < strlen($raw_tables); $c++) {
            $char = $raw_tables[$c];
            if (!$inTag && strcmp($char, '<') === 0) $inTag = true;
            else if ($inTag && strcmp($char, ' ') === 0) $afterSpace = true;
            else if ($inTag && strcmp($char, '>') === 0) { $inTag = false; $afterSpace = false; }

            if (!$afterSpace) $reduced_tables .= $char;
        }

        // Interpretation of data
        $parsed_tables = "";
        $machines = explode("<tr>", $reduced_tables);
        // From 2 because 0 is before table and 1 is head of table
        for ($m = 2; $m < count($machines); $m++) {
            // Each machine : Name | No | State | Program | Start | End in HTML table
            $parsed_args = [];
            $machine_raw_args = explode('</td>', $machines[$m]);
            $stillSameRaw = false;
            for ($c = 0; $c < count($machine_raw_args); $c++) {
                // Each columns (args)
                $raw = $machine_raw_args[$c];
                if (strpos($raw, '<table>') === false) {
                    $column = end(explode('>', $raw));
                    if ($column != '' && $column != ' ')
                        array_push($parsed_args, trim($column));
                } else {
                    $stillSameRaw = true;
                    array_push($parsed_args, '');
                }
            }
            $parsed_tables .= join('|', $parsed_args);
            if (!$stillSameRaw) $parsed_tables .= "\n";
        }

        // HTML interpretation
        $html_machines = [];
        $list_machines = explode("\n", $parsed_tables);
        for ($i = 0; $i < count($list_machines) - 1; $i++) {
            $machine = $list_machines[$i];
            $args = explode("|", $machine);
            if (count($args) == 5) {
                $no = $args[1];
                $program = $args[2];
                $start = $args[3];
                $end = $args[4];

                $curr_sec = HourStrToMinutesInt(date('H:i'));
                $start_sec = HourStrToMinutesInt($start);
                $end_sec = HourStrToMinutesInt($end);
                if ($start_sec > 23 * 60 && $end_sec < 60) $end_sec += 24 * 60; // Machines between 23h & 00h
                if ($start_sec > 23 * 60 && $curr_sec < 60) $curr_sec += 24 * 60; // Curr time between 00h & 01h
                $progression = intval(100 * ($curr_sec - $start_sec) / ($end_sec - $start_sec));
                $line = AddLine($no, 'EN COURS', $program, $progression, 'success', $start, $end);
                array_push($html_machines, $line);
            } else {
                $no = $args[1];
                $state = $args[2];
                $progression = 0;
                $color = 'primary';
                if ($state == 'REGLE') {
                    $progression = 100;
                    $color = 'danger';
                } else if ($state == 'TERMINE') {
                    $progression = 100;
                    $color = 'warning';
                }
                $line = AddLine($no, $state, '', $progression, $color);
                array_push($html_machines, $line);
            }
        }

        return $html_machines;
    }

?>