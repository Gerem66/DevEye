<?php

    /**
     * @param DataBase $db
     * @return bool True if the account was added, false otherwise
     */
    function Mails_AddAccount($db, $uid, $name, $email, $server, $password) {
        $varTypes = 'issss';
        $variables  = [ $uid, $name, $email, $server, $password ];
        $command = 'INSERT INTO TABLE (`UID`, `Name`, `Email`, `Server`, `Password`) VALUES (?, ?, ?, ?, ?)';
        $request = $db->QueryPrepare('_Mails', $command, $varTypes, $variables);
        return $request !== false;
    }

    /**
     * @param DataBase $db
     * @param User $user
     */
    function Mails_GetAccounts($db, $user) {
        $request = $db->QueryPrepare('_Mails', 'SELECT * FROM TABLE WHERE `UID` = ?', 'i', [$user->ID]);
        if ($request === false) return '';
        $accounts = array_map('Mails_AccountToHtml', $request);
        $accounts = implode('', $accounts);
        return "<ul>$accounts</ul>";
    }

    /**
     * @param DataBase $db
     * @param User $user
     * @param int $id
     * @param string $folder
     * @param string $server Get server from the database
     * @return \IMAP\Connection|false
     */
    function Mails_GetIMAP($db, $user, $id, $folder, &$server) {
        $mailInfo = $db->QueryPrepare('_Mails', 'SELECT * FROM TABLE WHERE `UID` = ? AND `ID` = ?', 'ii', [$user->ID, $id]);
        if ($mailInfo === false) return false;

        $mailInfo = $mailInfo[0];
        $server = $mailInfo['Server'];
        $email = $mailInfo['Email'];
        $password = $db->encryption->Decrypt($mailInfo['Password'], $user->hashedPassword);
        $imap = imap_open($server.$folder, $email, $password);
        if ($imap === false) {
            print_r(imap_errors());
            return false;
        }
        return $imap;
    }

    /**
     * @param \IMAP\Connection $imap
     * @param int $page
     */
    function Mails_GetMails($imap, $page = 0) {
        $MC = imap_check($imap);
        if ($MC === false) {
            print_r(imap_errors());
            imap_close($imap);
            return false;
        }

        $mailsLength = $MC->Nmsgs;
        $firstMail = $mailsLength - 20;

        $mails = imap_fetch_overview($imap, "$firstMail:$mailsLength", 0);
        if ($mails === false) {
            print_r(imap_errors());
            imap_close($imap);
            return false;
        }

        imap_close($imap);

        $mails = array_reverse($mails);
        $output = array_map('Mails_MailToHtml', $mails);
        return implode('', $output);
    }

    /**
     * @param \IMAP\Connection $imap
     * @param string $server
     * @param string $current
     */
    function Mails_LoadFolders($imap, $server, $current = 'INBOX') {
        $inbox_raw = imap_list($imap, $server, "*");

        $status = false; //imap_status($imap, $server.'INBOX', SA_UNSEEN);
        $unseen = $status !== false ? $status->unseen : 0;
        $inboxFolders = Mails_FolderToHtml('INBOX', $current, $unseen);

        for ($i = 0; $i < count($inbox_raw); $i++) {
            $name = substr($inbox_raw[$i], strlen($server));
            if ($name === 'INBOX') continue;

            $status = false; //imap_status($imap, $server.$name, SA_UNSEEN);
            $unseen = $status !== false ? $status->unseen : 0;
            $inboxFolders .= Mails_FolderToHtml($name, $current, $unseen);
        }
        return "<ul>$inboxFolders</ul>";
    }

    /**
     * @param \IMAP\Connection $imap
     * @param string $mailno
     * @return string|false
     */
    function Mails_ReadMailHead($imap, $mailno) {
        $headers = imap_fetchheader($imap, $mailno);
        return $headers;
    }

    /**
     * @param \IMAP\Connection $imap
     * @param string $mailno
     * @return string|false
     */
    function Mails_ReadMailBody($imap, $mailno) {
        $body = Mails_get_part($imap, $mailno, 'TEXT/HTML');
        if ($body === false) {
            $body = Mails_get_part($imap, $mailno, 'TEXT/PLAIN');
        }
        if (!mb_check_encoding($body, 'UTF-8')) {
            $body = utf8_encode($body);
        }
        return $body;
    }

    function Mails_get_part($imap, $mailno, $mimetype, $structure = false, $partNumber = false) {
        if ($structure === false) {
            $structure = imap_fetchstructure($imap, $mailno);
            if ($structure === false) return false;
        }

        if ($mimetype === get_mime_type($structure)) {
            if (!$partNumber) {
                $partNumber = 1;
            }

            $text = imap_fetchbody($imap, $mailno, $partNumber);
            switch ($structure->encoding) {
                case 3:
                    return imap_base64($text);
                case 4:
                    return imap_qprint($text);
                default:
                    return $text;
            }
        }

        // multipart
        if ($structure->type === 1) {
            foreach ($structure->parts as $index => $subStruct) {
                $prefix = "";
                if ($partNumber) {
                    $prefix = $partNumber . ".";
                }
                $data = Mails_get_part($imap, $mailno, $mimetype, $subStruct, $prefix . ($index + 1));
                if ($data) {
                    return $data;
                }
            }
        }

        return false;
    }

    function Mails_AccountToHtml($account) {
        $ID = $account['ID'];
        $Name = $account['Name'];
        $output = "<li name='mail-account' data-id='$ID'>
                        <a>$Name</a>
                    </li>";
        return $output;
    }

    function Mails_MailToHtml($mail) {
        $msgno = $mail->msgno;
        $message_id = $mail->message_id;

        $from = iconv_mime_decode($mail->from, 0, 'UTF-8');
        $subject = iconv_mime_decode($mail->subject, 0, 'UTF-8');
        $seen = $mail->seen;
        $favorite = $mail->flagged;
        $udate = $mail->udate;

        $seenClass = $seen ? '' : 'unseen';
        $time = dateToFrench(gmdate('Y-M-d H:i:s', $mail->udate), 'd M H:i');
        $timeSplit = explode(' ', $time);
        $time1 = substr(explode(':', $time)[0], 0, strlen($time) - 6);
        $time2 = end($timeSplit);

        return "<tr class='$seenClass' data-no='$msgno'>
                    <td><input name='mail-check' type='checkbox' value='0'></td>
                    <td class='mailbox-star'></td>
                    <td class='mailbox-name'>$from</td>
                    <td class='mailbox-subject'><p>$subject</p></td>
                    <td class='mailbox-attachment'></td>
                    <td class='mailbox-date'>$time1 <small>$time2</small></td>
                </tr>";
    }

    function Mails_FolderToHtml($folder, $current, $unseen) {
        $nb = $unseen > 0 ? $unseen : '';
        $active = $folder === $current ? "active" : "";

        //<i class='fas fa-inbox'></i>
        //<span class='badge float-right' style='margin-top: 4px;'>$nb</span>
        return "<li class='$active' data-folder='$folder'>
                    <a>$folder</a>
                </li>";
    }

?>