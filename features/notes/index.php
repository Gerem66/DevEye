<?php

    /**
     * @var User $user
     * @var DataBase $db
     */

    require(__DIR__.'/utils.php');

    if (isset($post['addNote'])) {
        $id = AddNote($db, $user);
        exit(GetContent($db, $user, $id));
    }
    if (isset($post['getContent'])) {
        $id = $post['getContent'];
        exit(GetContent($db, $user, $id));
    }
    if (isset($post['setContent'])) {
        $id = $post['setContent'];
        $success = SetContent($db, $user, $id, $post['newTitle'], $post['newContent']);
        if (!$success) {
            exit('{"status":"error"}');
        }
        exit(GetContent($db, $user, $id));
    }
    if (isset($post['removeNote'])) {
        $id = $post['removeNote'];
        $success = $db->Query("DELETE FROM `_Notes` WHERE `ID` = {$id} AND `UID` = {$user->ID}");
        if (!$success) {
            exit('{"status":"error"}');
        }
        exit('{"status":"ok"}');
    }

    $getNoteContent = fn($note) => "<li data-id='{$note['ID']}'><p>{$note['Title']}</p></li>";
    $notes = $db->GetRowsContent('_Notes', 'UID', $user->ID, '`ID`, `Title`');
    $notes = implode('', array_map($getNoteContent, $notes));

    $variables = array(
        'username' => $user->Username,
        'notes' => $notes
    );

    $content = ImportHTML(__DIR__.'/index.html', $variables);
    echo($content);

?>