<?php

    $ID = $_SESSION['ID'];
    $inst = $_SESSION['INSTANCE'];
    $project_folder = "instances/$inst/$ID/Projects";

    if (isset($_GET['id']))
    {
        ReadProject($_GET['id']);
    }
    else
    {
        ShowProjects();
    }

    // Show a project
    function ReadProject($i)
    {
        global $project_folder;

        $div_header = '<div class="card card-primary card-outline"><div class="card-header border-1"><h3 class="card-title"><i class="fas fa-align-left mr-1"></i>%TITLE%</h3><div class="card-tools"><button type="button" class="btn bg-primary btn-sm" data-card-widget="collapse" style="margin-right: 8px;"><i class="fas fa-minus"></i></button><button type="button" class="btn bg-primary btn-sm" data-card-widget="remove"><i class="fas fa-times"></i></button></div></div><div class="card-body" style="text-align: left;">';
        $div_footer = '</div></div>';

        if (!file_exists("$project_folder/project$i.pro")) {
            echo "<script>window.location.href = './projects';</script>";
            exit();
        }
        $content = explode("\n", file_get_contents("$project_folder/project$i.pro"));
        list($NAME, $DATE, $TYPE, $TEAM, $FILL, $STAT) = explode(',', reset($content));
        $username = $_SESSION['USERNAME'];

        echo "<div class='content-wrapper'>
                <div class='content-header'>
                    <div class='container-fluid'>
                        <div class='row mb-2'>
                            <div class='col-sm-6'>
                                <h1 class='m-0 text'>$NAME</h1>
                            </div>
                            <div class='col-sm-6'>
                                <ol class='breadcrumb float-sm-right'>
                                    <li class='breadcrumb-item'><a href='./user'>$username</a></li>
                                    <li class='breadcrumb-item'><a href='./projects'>Projects</a></li>
                                    <li class='breadcrumb-item active'>Project $i</li>
                                </ol>
                            </div>
                        </div>
                    </div>
                </div>
                <div class='row' style='margin: 0;'>';
                    <div class='col-2'></div>';
                        <section class='col-lg-8 connectedSortable'>"; 
        
        $indiv = false;
        $curr_star = 0;
        $curr_hash = 0;
        for ($i = 1; $i < count($content); $i++) {

            $line = $content[$i];
            $next_line = $content[$i+1];

            if ($line == "\r") echo "<br />";

            // *
            if ($curr_star == 0) {
                if (FormatCheck($line, '*')) Open_ul(1);
                else if (FormatCheck($line, '**')) Open_ul(2);
                else if (FormatCheck($line, '***')) Open_ul(3);
            } else if ($curr_star == 1) {
                if (FormatCheck($line, '*')) ;
                else if (FormatCheck($line, '**')) Open_ul(1);
                else if (FormatCheck($line, '***')) Open_ul(2);
                else Close_ul(1);
            } else if ($curr_star == 2) {
                if (FormatCheck($line, '*')) Close_ul(1);
                else if (FormatCheck($line, '**')) ;
                else if (FormatCheck($line, '***')) Open_ul(1);
                else Close_ul(2);
            } else if ($curr_star == 3) {
                if (FormatCheck($line, '*')) Close_ul(2);
                else if (FormatCheck($line, '**')) Close_ul(1);
                else if (FormatCheck($line, '***')) ;
                else Close_ul(3);
            }
            if ($l = FormatCheck($line, '*')) $curr_star = 1;
            else if ($l = FormatCheck($line, '**')) $curr_star = 2;
            else if ($l = FormatCheck($line, '***')) $curr_star = 3;
            else $curr_star = 0;

            // #
            if ($curr_hash == 0) {
                if (FormatCheck($line, '#')) Open_ol(1, ['']);
                else if (FormatCheck($line, '##')) Open_ol(2, ['', 'a']);
                else if (FormatCheck($line, '###')) Open_ol(3, ['', 'a', 'I']);
            } else if ($curr_hash == 1) {
                if (FormatCheck($line, '#')) ;
                else if (FormatCheck($line, '##')) Open_ol(1, ['a']);
                else if (FormatCheck($line, '###')) Open_ol(2, ['a', 'I']);
                else Close_ol(1, false);
            } else if ($curr_hash == 2) {
                if (FormatCheck($line, '#')) Close_ol(1);
                else if (FormatCheck($line, '##')) ;
                else if (FormatCheck($line, '###')) Open_ol(1, ['I']);
                else Close_ol(2);
            } else if ($curr_hash == 3) {
                if (FormatCheck($line, '#')) Close_ol(2);
                else if (FormatCheck($line, '##')) Close_ol(1);
                else if (FormatCheck($line, '###')) ;
                else Close_ol(3);
            }
            if ($l = FormatCheck($line, '#')) $curr_hash = 1;
            else if ($l = FormatCheck($line, '##')) $curr_hash = 2;
            else if ($l = FormatCheck($line, '###')) $curr_hash = 3;
            else $curr_hash = 0;

            // # Margin
            $margin = $curr_hash == 1 ? '72px' : '0';

            // Interprétation
            if ($l = FormatCheck($line, '==')) {
                if ($indiv) echo $div_footer;
                $indiv = true;
                echo str_replace("%TITLE%", $l, $div_header);
                //echo "<h2 style='margin-left: 24px; margin-right: 24px; border-bottom: 1px solid #a2a9b1;'>$l</h2>";
            }
            else if ($l = FormatCheck($line, '==='))
                echo "<h3 style='margin-left: 48px;'>$l</h3>";
            else if ($l = FormatCheck($line, ':-'))
                echo "<p style='margin: 0 48px 0;'>- $l</p>";
            else if ($l = FormatCheck($line, '::-'))
                echo "<p style='margin: 0 72px 0;'>- $l</p>";
            else if ($l = FormatCheck($line, ':::-'))
                echo "<p style='margin: 0 96px 0;'>- $l</p>";
            // *
            else if ($l = FormatCheck($line, '*'))
                echo "<li style='margin: 0 72px 0;'>$l</li>";
            else if ($l = FormatCheck($line, '**'))
                echo "<li style='margin: 0 72px 0;'>$l</li>";
            else if ($l = FormatCheck($line, '***'))
                echo "<li style='margin: 0 72px 0;'>$l</li>";
            // #
            else if ($l = FormatCheck($line, '#'))
                echo "<li style='margin: 0 $margin 0;'>$l" . (FormatCheck($next_line, '##') || FormatCheck($next_line, '###') ? "" : "</li>");
            else if ($l = FormatCheck($line, '##'))
                echo "<li style='margin: 0 $margin 0;'>$l" . (FormatCheck($next_line, '###') ? "" : "</li>");
            else if ($l = FormatCheck($line, '###'))
                echo "<li style='margin: 0 $margin 0;'>$l</li>";
            else
                echo "<p style='margin: 0 48px 0;'>$line</p>";
        }

        if ($indiv) echo $div_footer;
        echo '</section></div></div>';
    }

    // List of projects
    function ShowProjects()
    {
        global $project_folder;

        ShowHeader();

        $files = [];
        if ($handle = opendir($project_folder))
            while (false !== ($entry = readdir($handle)))
                if ($entry != "." && $entry != ".." && end(explode('.', $entry)) == "pro")
                    array_push($files, "$project_folder/$entry");
            closedir($handle);
        sort($files);
        foreach (array_reverse($files) as $file)
            ShowProject($file);
            
        ShowFooter();
    }

    function ShowHeader()
    {
        global $project_folder;
        $username = $_SESSION['USERNAME'];

        $n = 0;
        if ($handle = opendir($project_folder))
            while (false !== ($entry = readdir($handle)))
                while ($entry != "." && $entry != ".." && end(explode('.', $entry)) == "pro" && intval(substr("$project_folder/$entry", strlen("$project_folder/$entry") - 7, 3)) >= $n)
                    $n++;
        $n = $n < 10 ? "00$n" : ($n < 100 ? "0$n" : $n);

        echo '<div class="content-wrapper">
                <div class="content-header">
                    <div class="container-fluid">
                        <div class="row mb-2">
                            <div class="col-sm-6">
                                <h1 class="m-0 text">Projets</h1>
                            </div>
                            <div class="col-sm-6">
                                <ol class="breadcrumb float-sm-right">
                                    <li class="breadcrumb-item"><a href="./user">'.$username.'</a></li>
                                    <li class="breadcrumb-item active">Projects</li>
                                </ol>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="content">
                    <div class="container-fluid">
                        <section class="content">
                                <div class="card">
                                    <div class="card-header">
                                        <h3 class="card-title">Projects</h3>

                                        <div class="card-tools">
                                            <a class="btn btn-primary btn-sm" href="./editproject-'.$n.'">
                                                <i class="fas fa-plus"></i> Ajouter une nouveau projet
                                            </a>
                                            <!--button type="button" class="btn btn-tool" data-card-widget="collapse" data-toggle="tooltip" title="Collapse">
                                            <i class="fas fa-minus"></i></button-->
                                            <!--button type="button" class="btn btn-tool" data-card-widget="remove" data-toggle="tooltip" title="Remove">
                                            <i class="fas fa-times"></i></button-->
                                        </div>
                                    </div>
                                    <div class="card-body p-0">
                                    <table class="table table-striped projects">
                                        <thead>
                                            <tr>
                                                <th style="width: 1%">#</th>
                                                <th style="width: 14%">Nom du projet</th>
                                                <th style="width: 12%">Type</th>
                                                <th style="width: 25%">Equipe</th>
                                                <th>Progression du projet</th>
                                                <th style="width: 2%" class="text-center">Statut</th>
                                                <th style="width: 15%"></th>
                                            </tr>
                                        </thead>';
    }

    function ShowProject($i)
    {
        $ID = substr($i, strlen($i) - 7, 3);
        list($NAME, $DATE, $TYPE, $TEAM, $FILL, $STAT, $UIST) = explode(',', reset(explode("\n", file_get_contents($i))));

        echo "<tbody>
                <tr>
                    <td>$ID</td>
                    <td>
                        <a>$NAME</a>
                        <br/>
                        <small>Créé le $DATE</small>
                    </td>
                    <td>
                        <a>$TYPE</a>
                    </td>
                    <td>
                        <ul class='list-inline'>
                            <li class='list-inline-item'>
                                <img alt='Avatar' class='table-avatar' src='dist/img/$TEAM'>
                            </li>
                        </ul>
                    </td>
                    <td class='project_progress'>
                        <div class='progress progress-sm'>
                            <div class='progress-bar bg-$UIST' role='progressbar' aria-volumenow='$FILL' aria-volumemin='0' aria-volumemax='100' style='width: $FILL%'>
                            </div>
                        </div>
                        <small>$FILL% Terminé</small>
                    </td>
                    <td class='project-state'>
                        <span class='badge bg-$UIST'>$STAT</span>
                    </td>
                    <td class='project-actions text-right'>
                        <a class='btn btn-primary btn-sm' href='./projects-$ID'>
                            <i class='fas fa-folder'></i>
                            Afficher
                        </a>
                        <a class='btn btn-info btn-sm' href='./editproject-$ID'>
                            <i class='fas fa-pencil-alt'></i>
                            Modifier
                        </a>
                    </td>
                </tr>
            </tbody>";
    }

    function ShowFooter()
    {
        echo '</table></div></div></section></div></div></div>';
    }

    // Functions
    function startsWith ($string, $startString)
    {
        $len = strlen($startString);
        return (substr($string, 0, $len) === $startString);
    }
    function endsWith($string, $endString)
    {
        $len = strlen($endString);
        if ($len == 0) return true;
        return (substr($string, -$len) === $endString);
    }
    function FormatCheck($text, $balise)
    {
        $txt_len = strlen($text);
        $bal_len = strlen($balise);

        $start_check = startsWith($text, "$balise ");
        $end_check = endsWith($text, " $balise\r");

        $result = substr($text, $start_check ? ($bal_len + 1) : 0, $end_check ? ($txt_len - ($bal_len + 1) * 2) : $txt_len);

        return $result == $text ? 0 : $result;
    }
    function Open_ul($n) {
        for ($i = 0; $i < $n; $i++)
            echo "<ul style='margin-bottom: 0;'>";
    }
    function Close_ul($n) {
        for ($i = 0; $i < $n; $i++)
            echo "</ul>";
    }
    function Open_ol($n, $type = []) {
        for ($i = 0; $i < $n; $i++) {
            $t = $i < count($type) ? $type[$i] : '';
            echo "<ol style='margin-bottom: 0;' type='$t'>";
        }
    }
    function Close_ol($n, $last = true) {
        for ($i = 0; $i < $n; $i++)
            echo "</ol>" . ($last ? "" : "</li>");
    }

?>