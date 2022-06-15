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

        switch ($type) {
            case 'add':
                $name = $args['Name'];
                $email = $args['Email'];
                $server = $args['Server'];
                $password = $args['Password'];
                if (!isset($name, $email, $server, $password)) {
                    break;
                }

                $password = $db->encryption->Encrypt($password, $user->hashedPassword);
                $added = Mails_AddAccount($db, $user->ID, $name, $email, $server, $password);
                if ($added) $status['status'] = 'ok';

            case 'get':
                $accountID = $args['accountID'];
                $getFolders = $args['getFolders'] ?? false;
                if (!isset($accountID)) break;

                $folderDefined = array_key_exists('folder', $args);
                $folder = $folderDefined ? $args['folder'] : 'INBOX';

                $server = '';
                $inbox = Mails_GetInbox($db, $user, $accountID, $folder, $server);
                if ($inbox === false) break;

                $mailContent = Mails_GetMails($inbox);
                if ($mailContent === false) break;

                if ($getFolders) {
                    $foldersContent = Mails_LoadFolders($inbox, $server);
                    if ($foldersContent === false) break;
                    $status['folders'] = $foldersContent;
                }

                $status['status'] = 'ok';
                $status['mails'] = $mailContent;
                break;

            case 'remove':
                // TODO - Remove mail
                break;
        }

        return $status;
    };

    $foldersTest = '<ul>
                        <li><a>Folder 1</a></li>
                        <li class="selected"><a>Folder 2</a></li>
                        <li><a>Folder 3</a></li>
                        <li><a>Folder 4</a></li>
                    </ul>';

    $accounts = Mails_GetAccounts($db, $user);

    $variables = array(
        'username' => $user->Username,
        'accounts' => $accounts
    );
    $popupsVars = array();

    $content = ImportHTML(__DIR__.'/popups.html', $popupsVars);
    $content .= ImportHTML(__DIR__.'/index.html', $variables);

    return $content;

?>