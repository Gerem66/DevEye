<?php

    /**
     * @param DataBase $db
     * @param User $user
     * @return int The ID of the new note.
     */
    function AddNote($db, $user) {
        $defaultTitle = $db->encryption->Encrypt('Nouvelle Note', $user->hashedPassword);
        $result = $db->QueryPrepare('_Notes', "INSERT INTO TABLE (`UID`, `Title`, `Content`) VALUES (?, ?, '')", 'is', array($user->ID, $defaultTitle));
        if ($result === false) {
            return false;
        }
        return $db->GetLastInsertedID();
    }

    /**
     * @param DataBase $db
     * @param User $user
     * @param int $id
     * @return array|false The object containing all note's informations.
     */
    function Notes_GetContent($db, $user, $id) {
        $notes = $db->QueryPrepare('_Notes', "SELECT * FROM TABLE WHERE `ID` = ? AND `UID` = ?", 'ii', array($id, $user->ID));
        if ($notes === false || count($notes) === 0) {
            return false;
        }
        $note = $notes[0];
        $title = $db->encryption->Decrypt($note['Title'], $user->hashedPassword);
        $content = $db->encryption->Decrypt($note['Content'], $user->hashedPassword);
        $result = array(
            'id' => $id,
            'status' => 'ok',
            'title' => $title,
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
    function Notes_GetRawContent($db, $user, $id) {
        $notes = $db->QueryPrepare('_Notes', "SELECT `Content` FROM TABLE WHERE `ID` = ? AND `UID` = ?", 'ii', array($id, $user->ID));
        if ($notes === false || count($notes) === 0) {
            return false;
        }
        $content = $db->encryption->Decrypt($notes[0]['Content'], $user->hashedPassword);
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
        if (strlen($newTitle) > 128) {
            $newTitle = substr($newTitle, 0, 128);
        }
        $encryptTitle = $db->encryption->Encrypt($newTitle, $user->hashedPassword);
        $encryptContent = $db->encryption->Encrypt($newContent, $user->hashedPassword);
        $args = array($encryptTitle, $encryptContent, $id, $user->ID);
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
        $content = Notes_GetContent($db, $user, $id);
        if ($content === false) return false;
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