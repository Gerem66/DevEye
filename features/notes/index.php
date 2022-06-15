<?php

    /**
     * @var User $user
     * @var DataBase $db
     * @var Feature[] $features
     */

    include_once(__DIR__.'/utils.php');

    /**
     * @param DataBase $db
     * @param User $user
     * @param string $type
     * @param array $args
     * @return array Array returned to the client
     */
    $action = function($db, $user, $type, $args) {
        $status = array('status' => 'error');

        if ($type === 'addNote') {
            $id = AddNote($db, $user);
            if ($id !== false) {
                $content = Notes_GetContent($db, $user, $id);
                if ($content !== false) $status = $content;
            }
        }

        else if ($type === 'getContent' && isset($args['id'])) {
            $id = $args['id'];
            $content = Notes_GetContent($db, $user, $id);
            if ($content !== false) $status = $content;
        }

        else if ($type === 'setContent' && isset($args['id'], $args['newTitle'], $args['newContent'])) {
            $id = $args['id'];
            $success = SetContent($db, $user, $id, $args['newTitle'], $args['newContent']);
            if ($success) {
                $content = Notes_GetContent($db, $user, $id);
                if ($content !== false) $status = $content;
            }
        }

        else if ($type === 'deleteNote' && isset($args['id'])) {
            $id = $args['id'];
            $success = $db->QueryPrepare('_Notes', "DELETE FROM TABLE WHERE `ID` = ? AND `UID` = ?", 'ii', array($id, $user->ID));
            if ($success) $status['status'] = 'ok';
        }

        else if ($type === 'checkSquare' && isset($args['id'], $args['squareID'])) {
            $id = $args['id'];
            $checkboxID = $args['squareID'];
            $success = SetCheckbox($db, $user, $id, $checkboxID);
            if ($success) {
                $content = Notes_GetRawContent($db, $user, $id);
                if ($content !== false) $status = $content;
            }
        }

        return $status;
    };

    $getNoteContent = function($note, $db, $user) {
        $title = $db->encryption->Decrypt($note['Title'], $user->hashedPassword);
        return "<li data-id='{$note['ID']}'><p>{$title}</p></li>";
    };
    $command = "SELECT `ID`, `Title` FROM TABLE WHERE `UID` = ? ORDER BY `Last` DESC";
    $notes = $db->QueryPrepare('_Notes', $command, 'i', array($user->ID));
    $notes = implode('', array_map(fn($n) => $getNoteContent($n, $db, $user), $notes));

    $variables = array(
        'username' => $user->Username,
        'notes' => $notes
    );
    return ImportHTML(__DIR__.'/index.html', $variables);

?>