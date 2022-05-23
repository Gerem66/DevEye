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
     * @return array The object containing all note's informations.
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
        return $result;
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

    /**
     * @param DataBase $db
     * @param User $user
     * @param int $id
     * @param int $checkboxID
     * @return bool Success
     */
    function SetCheckbox($db, $user, $id, $checkboxID) {
        $content = GetContent($db, $user, $id);
        $rawContent = $content['rawContent'];
        $lines = explode("\n", $rawContent);
        $checkboxIndex = 0;
        $allCheckboxTypes = array('[]', '[ ]', '[x]', '[v]');
        $edited = false;

        for ($i = 0; $i < count($lines); $i++) {
            // Get after first space
            $start = substr($lines[$i], 0, strpos($lines[$i], ' ') + 1);
            $line = substr($lines[$i], strpos($lines[$i], ' ') + 1);
            $checkboxType = false;
            foreach ($allCheckboxTypes as $type) {
                if (StartsWith($line, $type)) {
                    $checkboxType = $type;
                    break;
                }
            }

            if ($checkboxType !== false && $checkboxIndex == $checkboxID) {
                switch ($checkboxType) {
                    case '[]':
                    case '[ ]':
                        $lines[$i] = $start . '[v]' . substr($line, strlen($checkboxType));
                        $edited = true;
                        break;
                    case '[x]':
                    case '[v]':
                        $lines[$i] = $start . '[]' . substr($line, strlen($checkboxType));
                        $edited = true;
                        break;
                }
                if ($edited) {
                    break;
                }
            }

            if ($checkboxType !== false) {
                $checkboxIndex++;
            }
        }

        if (!$edited) {
            return false;
        }
        return SetContent($db, $user, $id, $content['title'], implode("\n", $lines));
    }

?>