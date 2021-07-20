<?php

    $username = $_SESSION['USERNAME'];
    $team = GetPostValue('team', 0);
    $team_txt = $team ? '1' : '0';

    function MdToHtml($lines) {
        global $team_txt;

        function AddCard($title, $content) {
            $output = '<div class="card card-primary card-outline">
                        <div class="card-header border-1">
                            <h3 class="card-title"><i class="fas fa-align-left mr-1"></i>'.$title.'</h3>
                            <div class="card-tools">
                                <button type="button" class="btn bg-primary btn-sm" data-card-widget="collapse" style="margin-right: 8px;"><i class="fas fa-minus"></i></button>
                            </div>
                        </div>
                        <div class="card-body" style="padding-bottom: 48px;">
                            <div class="col-10" style="margin: auto;">'.$content.'</div>
                        </div>
                    </div>';
            return $output;
        }

        $content = '';
        $incard = false;
        $inlist = false;
        $currtitle = '';
        $currcontent = '';
        $square_nb = 0;
        foreach ($lines as $line)
        {
            $pre = explode(' ', $line)[0];
            if (strlen($line) >= strlen($pre) + 1)
                $l = substr($line, strlen($pre) + 1);

            if ($inlist && $pre != '*' && $pre != '**' && $pre != '[]' && $pre != '[x]' && $pre != '[v]') {
                $currcontent .= "</ul>";
                $inlist = false;
            }

            if ($pre == '#') {
                if ($incard) {
                    $content .= AddCard($currtitle, $currcontent);
                    $currtitle = '';
                    $currcontent = '';
                }
                $currtitle = substr($line, 2);
                $incard = true;
            } else if ($pre == '##') {
                $currcontent .= "<h2 style='margin-top: 24px; margin-left: -24px;'>$l</h2>";
            } else if ($pre == '###') {
                $currcontent .= "<h3>$l</h3>";
            } else if ($pre == '*' || (strlen($pre) < 4 && $pre[0] == '[' && $pre[-1] == ']')) {
                if (!$inlist) {
                    $currcontent .= "<ul>";
                    $inlist = true;
                }
                if ($pre == '*') {
                    $currcontent .= "<li>$l</li>";
                } else {
                    $square_icon = strlen($pre) == 2 ? "square" : "check-square";
                    $currcontent .= "<li style='list-style: none;'>
                                        <i id='$square_nb' class='far fa-$square_icon a' style='margin-right: 12px;' onclick='SquareClick(this, \"$team_txt\");'></i>$l
                                    </li>";
                    $square_nb += 1;
                }
            } else if ($pre == '**') {
                $currcontent .= "<li style='margin-left: 24px;'>$l</li>";
            } else if ($line != '') {
                $currcontent .= "<p>$line</p>";
            }
        }

        if ($incard) {
            $content .= AddCard($currtitle, $currcontent);
            $currtitle = '';
            $currcontent = '';
        }

        $content = str_replace('->', '<i class="fas fa-arrow-right"></i>', $content);
        return $content;
    }

    // [Save data &] Get data
    $db = new DataBase;
    if (isset($_POST['save'], $_POST['tb_content'])) {
        $ID = $team ? $_SESSION['INSTANCE_ID'] : $_SESSION['ID'];
        $table = $team ? 'Instances' : 'Users';
        $db->SaveCellContent($table, 'Logbook', $ID, $_POST['tb_content']);
        $lines = explode("\n", $_POST['tb_content']);
    } else {
        if ($team) $data = $db->GetCellContent('Instances', 'Logbook', $_SESSION['INSTANCE_ID']);
        else $data = $db->GetCellContent('Users', 'Logbook', $_SESSION['ID']);
        $lines = explode("\n", $data);
    }

    // Switch square
    if (isset($_POST['square_toggle'])) {
        $ID = $team ? $_SESSION['INSTANCE_ID'] : $_SESSION['ID'];
        $table = $team ? 'Instances' : 'Users';

        $square_id = $_POST['square_toggle'];
        $square_nb = 0;
        for ($i = 0; $i < count($lines); $i++) {
            $pre = explode(' ', $lines[$i])[0];
            if (strlen($lines[$i]) >= strlen($pre) + 1)
                $l = substr($lines[$i], strlen($pre) + 1);

            if (strlen($pre) < 4 && $pre[0] == '[' && $pre[-1] == ']') {
                if ($square_nb == $square_id) {
                    if (strlen($pre) == 2) {
                        $lines[$i] = "[v] $l";
                        echo("OK");
                    }
                    else if (strlen($pre) == 3) {
                        $lines[$i] = "[] $l";
                        echo("OK");
                    }
                    break;
                }
                $square_nb += 1;
            }
        }
        // Get old text
        // Change square at index
        // Save new text
        // Print OK or nothing
        $db->SaveCellContent($table, 'Logbook', $ID, join("\n", $lines));
        exit();
    }

    $content = MdToHtml($lines);
    $icon = $team ? '<i class="fas fa-users" style="margin: 0 24px;"></i>' : '';
    $title_txt = $team ? '-team' : '';

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text"><?= $icon ?>Journal de bord
                        <button type="button" class="btn btn-primary btn-sm col-2 fbtn" onclick="LoadPage('logbook-edit', {'team': <?= $team_txt ?>});">Modifier</button>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $username ?></a></li>
                        <li class="breadcrumb-item active">Logbook<?= $title_txt ?></li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">
            <section class="col-lg-8 card-center">
                <?= $content ?>
            </section>
        </div>
    </div>
</div>