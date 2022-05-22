<?php

    /**
     * @param DataBase $db
     * @param User $user
     * @return int The ID of the new note.
     */
    function AddNote($db, $user) {
        $result = $db->Query("INSERT INTO `_Notes` (`UID`, `Title`, `Content`) VALUES ({$user->ID}, 'Nouvelle Note', '')");
        if (!$result) {
            exit('{"status":"error"}');
        }
        return $db->GetLastInsertedID();
    }

    /**
     * @param DataBase $db
     * @param User $user
     * @param int $id
     */
    function GetContent($db, $user, $id) {
        $note = $db->Query("SELECT * FROM `_Notes` WHERE `ID` = {$id} AND `UID` = {$user->ID}")->fetch_assoc();
        $content = $db->Decrypt($note['Content']);
        $result = array(
            'id' => $id,
            'status' => 'ok',
            'title' => $note['Title'],
            'rawContent' => $content,
            'content' => TextMdToHtml($content),
            'date' => $note['Date']
        );
        return json_encode($result);
    }

    /**
     * @param DataBase $db
     * @param User $user
     * @param int $id
     * @param string $newTitle
     * @param string $newContent
     * @return bool Success
     */
    function SetContent($db, $user, $id, $newTitle, $newContent) {
        $encrypt = $db->Encrypt($newContent);
        $result = $db->Query("UPDATE `_Notes` SET `Title` = '{$newTitle}', `Content` = '{$encrypt}', `Last` = CURRENT_TIMESTAMP() WHERE `ID` = {$id} AND `UID` = {$user->ID}");
        return $result !== false;
    }

    function TextMdToHtml($lines) {
        $lines = explode("\n", $lines);
        $lines = array_map('trim', $lines);
        $content = '';

        $square_nb = 0;
        $inlist = false;

        foreach ($lines as $line) {
            $pre = explode(' ', $line)[0];
            if (strlen($line) >= strlen($pre) + 1)
                $l = substr($line, strlen($pre) + 1);

            if ($inlist && $pre != '*' && $pre != '**' && $pre != '[]' && $pre != '[x]' && $pre != '[v]') {
                $content .= "</ul>";
                $inlist = false;
            }

            if ($pre == '#') {
                $content .= "<h1>$l</h1>";
            } else if ($pre == '##') {
                $content .= "<h2>$l</h2>";
            } else if ($pre == '###') {
                $content .= "<h3>$l</h3>";
            } else if ($pre == '*' || (strlen($pre) < 4 && $pre[0] == '[' && $pre[-1] == ']')) {
                if (!$inlist) {
                    $content .= "<ul>";
                    $inlist = true;
                }
                if ($pre == '*') {
                    $content .= "<li>$l</li>";
                } else {
                    //$square_icon = strlen($pre) == 2 ? "square" : "check-square";
                    $content .= "<li><i id='$square_nb' class=''></i>$l</li>";
                    $square_nb += 1;
                }
            } else if ($pre == '**') {
                $content .= "<li>$l</li>";
            } else if ($line != '') {
                $content .= "<p>$line</p>";
            }
        }

        $content = str_replace('->', '<i class="fas fa-arrow-right"></i>', $content);
        return $content;
    }

?>