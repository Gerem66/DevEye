<?php

    /**
     * @param DataBase $db
     * @param int $uid
     * @param string $clearPassword
     * @return bool|null True if password is correct, false otherwise or null if error
     */
    function CheckPassword($db, $uid, $clearPassword) {
        $u = $db->QueryPrepare('Users', 'SELECT * FROM TABLE WHERE `ID` = ?', 'i', [$uid]);
        if ($u === false || count($u) === 0) return null;
        return password_verify($clearPassword, $u[0]['Password']);
    }

    /**
     * Get encrypted content from password informations
     * @param DataBase $db
     * @param string $hash User's hashed password
     * @param string $service
     * @param string $username
     * @param string $password
     * @param string $status
     */
    function GetPasswordContent($db, $hash, $service, $username, $password, $status) {
        $variables = array(
            'service' => $service,
            'username' => $username,
            'password' => $password,
            'status' => $status
        );
        return $db->encryption->Encrypt(json_encode($variables), $hash);
    }

    /**
     * @param DataBase $db
     * @param int $userID
     * @param string $category
     * @return bool true if success, false if failed
     */
    function AddPassword($db, $userID, $category, $content) {
        $args = array($userID, $category, $content);
        $command = 'INSERT INTO TABLE (`UID`, `Category`, `Content`) VALUES (?, ?, ?)';
        $result = $db->QueryPrepare('_Passwords', $command, 'iss', $args);
        return $result !== false;
    }

    /**
     * @param DataBase $db
     * @param int $userID
     * @param int $id
     * @param string $newCategory
     * @param array $newContent
     * @return bool true if success, false if failed
     */
    function EditPassword($db, $userID, $id, $newCategory, $newContent) {
        $args = array($newCategory, $newContent, $id, $userID);
        $command = 'UPDATE TABLE SET `Category` = ?, `Content` = ? WHERE `ID` = ? AND `UID` = ?';
        $result = $db->QueryPrepare('_Passwords', $command, 'ssii', $args);
        return $result !== false;
    }

    function AddCard($title, $content) {
        return "<div class='card col-two-thirds responsive card-password' data-title='$title'>
                    <div class='card-header password-header'>
                        <a name='btn-edit-category' data-title='$title' class='link'>Modifier la catégorie</a>
                        <a name='btn-add-password' data-title='$title' class='link'>Ajouter un mot de passe</a>
                    </div>
                    <div class='table-scroll-mode'>
                        <table class='show-lines table-passwords'>
                            <thead>
                                <tr>
                                    <th style='width: 20%'>Service</th>
                                    <th>Nom d'utilisateur / Email</th>
                                    <th style='width: 20%'>Mot de passe</th>
                                    <th style='width: 10%'>Status</th>
                                    <th style='width: 5%'></th>
                                </tr>
                            </thead>
                            <tbody>
                                $content
                            </tbody>
                        </table>
                    </div>
                </div>";
    }

    function AddRow($ID, $service, $username, $status, $showPassword) {
        $color = '';
        $formatStatus = 'Autre';
        if ($status === 'enable') { $formatStatus = 'Actif'; $color = ' style="color: #2ecc71"'; }
        else if ($status === 'disable') { $formatStatus = 'Inactif'; $color = ' style="color: #e74c3c"'; }
        else if ($status === 'none') $formatStatus = 'Indéterminé';

        $password = $showPassword ? "<p>**********</p><i name='icon-show-password' class='icon icon-eye-open'></i>" : '';
        return "<tr data-id='$ID'>
                    <td>$service</td>
                    <td>$username</td>
                    <td>$password</td>
                    <td$color data-status='$status'>$formatStatus</td>
                    <td><i name='icon-other' class='icon icon-other'></i></td>
                </tr>";
    }

?>