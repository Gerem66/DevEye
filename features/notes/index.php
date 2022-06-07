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
     * @return string String returned to the client
     */
    $action = function($db, $user, $type, $args) {
        if ($type === 'addNote') {
            $id = AddNote($db, $user);
            if ($id === false) return 'error';
            $content = Notes_GetContent($db, $user, $id);
            if ($content === false) return 'error';
            return json_encode($content);
        }

        if ($type === 'getContent') {
            if (!isset($args['id'])) return 'error';
            $id = $args['id'];
            $content = Notes_GetContent($db, $user, $id);
            if ($content === false) return 'error';
            return json_encode($content);
        }

        if ($type === 'setContent') {
            if (!isset($args['id'], $args['newTitle'], $args['newContent'])) return 'error';
            $id = $args['id'];
            $success = SetContent($db, $user, $id, $args['newTitle'], $args['newContent']);
            if (!$success) return 'error';
            $content = Notes_GetContent($db, $user, $id);
            if ($content === false) return 'error';
            return json_encode($content);
        }

        if ($type === 'deleteNote') {
            if (!isset($args['id'])) return 'error';
            $id = $args['id'];
            $success = $db->QueryPrepare('_Notes', "DELETE FROM TABLE WHERE `ID` = ? AND `UID` = ?", 'ii', array($id, $user->ID));
            if ($success === false) return 'error';
            return 'ok';
        }

        if ($type === 'checkSquare') {
            if (!isset($args['id'], $args['squareID'])) return 'error';
            $id = $args['id'];
            $checkboxID = $args['squareID'];
            $success = SetCheckbox($db, $user, $id, $checkboxID);
            if (!$success) return 'error';
            $content = Notes_GetRawContent($db, $user, $id);
            if ($content === false) return 'error';
            return json_encode($content);
        }
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