<?php

    /**
     * @param DataBase $db
     * @param int $userID
     * @param string $category
     * @param string $service
     * @param string $username
     * @param string $password
     * @param string $status
     * @return bool true if success, false if failed
     */
    function AddPassword($db, $userID, $category, $service, $username, $password, $status) {
        $variables = array(
            'service' => $service,
            'username' => $username,
            'password' => $password,
            'status' => $status
        );
        $content = $db->Encrypt(json_encode($variables));
        $args = array($userID, $category, $content);
        $result = $db->QueryPrepare("_Passwords", "INSERT INTO TABLE (`UID`, `Category`, `Content`) VALUES (?, ?, ?)", 'iss', $args);
        return $result !== false;
    }

    function AddCard($title, $content, $length) {
        return "<div class='card col-two-thirds responsive card-password' data-title='$title ($length)'>
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

    function AddRow($ID, $service, $username, $status) {
        return "<tr data-id='$ID'>
                    <td>$service</td>
                    <td>$username</td>
                    <td><p>**********</p><i name='icon-show-password' class='icon icon-eye-open'></i></td>
                    <td>$status</td>
                    <td><i name='icon-other' class='icon icon-other'></i></td>
                </tr>";
    }

?>