<?php

    /**
     * @param DataBase $db
     * @param User $user
     * @return int The ID of the new note.
     */
    function AddNote($db, $user) {
        $result = $db->QueryPrepare('_Notes', "INSERT INTO TABLE (`UID`, `Title`, `Content`) VALUES (?, 'Nouvelle Note', '')", 'i', array($user->ID));
        if ($result === false) {
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
    function GetNotesContent($db, $user, $id) {
        $notes = $db->QueryPrepare('_Notes', "SELECT * FROM TABLE WHERE `ID` = ? AND `UID` = ?", 'ii', array($id, $user->ID));
        if ($notes === false || count($notes) === 0) {
            exit('{"status":"error"}');
        }
        $note = $notes[0];
        $content = $db->Decrypt($note['Content']);
        $result = array(
            'id' => $id,
            'status' => 'ok',
            'title' => $note['Title'],
            'rawContent' => $content,
            'content' => TextMdToHtml($content),
            'last' => $note['Last'],
            'date' => $note['Date']
        );
        return $result;
    }

    /**
     * @param DataBase $db
     * @param User $user
     * @param int $id
     * @return array The object containing all note's informations.
     */
    function GetNotesRawContent($db, $user, $id) {
        $notes = $db->QueryPrepare('_Notes', "SELECT `Content` FROM TABLE WHERE `ID` = ? AND `UID` = ?", 'ii', array($id, $user->ID));
        if ($notes === false || count($notes) === 0) {
            exit('{"status":"error"}');
        }
        $content = $db->Decrypt($notes[0]['Content']);
        $result = array(
            'status' => 'ok',
            'rawContent' => $content,
            'content' => TextMdToHtml($content)
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
        $args = array($newTitle, $encrypt, $id, $user->ID);
        $result = $db->QueryPrepare('_Notes', "UPDATE TABLE SET `Title` = ?, `Content` = ?, `Last` = CURRENT_TIMESTAMP() WHERE `ID` = ? AND `UID` = ?", 'ssii', $args);
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
        $content = GetNotesContent($db, $user, $id);
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