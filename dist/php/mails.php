<?php

    // Google 1,{imap.gmail.com:993/imap/ssl/novalidate-cert}INBOX,geremy.lecaplain66@gmail.com,ccbbxcaenvvijcfd,blue,0
    // Google 2,{imap.gmail.com:993/imap/ssl/novalidate-cert}INBOX,geremy.lecaplain@gmail.com,ioesfqatoztnlcou,blue,0
    // INSA,{imap.etud.insa-toulouse.fr:993/imap/ssl}INBOX,lecaplai@etud.insa-toulouse.fr,qx!V9377,red,0
    // 8dRMGl08vf2taZzKDk0eYSaWBGsLsxQ0RVOHOm+/LlFIwJREl7SAUaDZyHK8TSaIYcyCSRm6qHLC5PTP+DQaeHxB4YhwPfEMjPiJU5izOdICNvilv/5C1FAj6ETyvjjTKf1F9wEzAdVdoKjP/torlkCi7iVvsmK/VCm/XRQH/atZJKEPK6LS9X/nzaR3hCjNSKgyyp3U78ej39VwOgmtFFeWdc0OtyWghAFPSyy5EkQvqlZJDq/XEbRkSI3oHgDW3yBudJkRGXWt9VI1h/qO2+XBt5B17LHNm8+Clm52SAfxnyXoVakaCW3ND/l/m2YAaG+1nTD3JVg5we9n10VcIffVxCOPupkEdEH/hsL9yYkQUstjkZAgcRmoZfb3H3/jYYt71IAFIkqaoYKeZW7SQVumaPBtA92i+b5DQhn7DCTBAJPojRcZawcmzzbNxyLVjwU30fwklVIMUZM8a1tJB4CBYFqyhtlL3z8Wc3ZdUACSvkLCVeAUc5KevRd6RYn6hlMANf5l3MlYrAhtpw1p8g==

    function SaveMailBox() {
        $newContent = "";
        $ID = $_SESSION['ID'];
        $save_ID = intval($_POST['save']);
        $db = new DataBase;
        $content = $db->GetCellContent('Users', 'Mails', $ID);
        if ($content) {
            $lines = explode("\n", $content);
            $newMail = [ $_POST['value_title'], $_POST['value_server'], $_POST['value_mail'],
                        $_POST['value_password'], $_POST['value_color'], '0' ];
            if ($save_ID < count($lines)) $lines[$save_ID] = join(',', $newMail);
            else array_push($lines, join(',', $newMail));
            $newContent = join("\n", $lines);
            $db->SaveCellContent('Users', 'Mails', $ID, $newContent);
        }
        exit();
    }

    function RemoveMailBox() {
        $ID = $_SESSION['ID'];
        $delete_ID = intval($_POST['delete']);
        $db = new DataBase;
        $content = $db->GetCellContent('Users', 'Mails', $ID);
        if ($content) {
            $lines = explode("\n", $content);
            if ($delete_ID < count($lines)) {
                unset($lines[$delete_ID]);
                $newContent = join("\n", $lines);
                $db->SaveCellContent('Users', 'Mails', $ID, $newContent);
            }
        }
        exit();
    }

    function RemoveMails($mailbox, $mailsToDelete) {
        $uids = explode(',', $mailsToDelete);
        for ($i = 0; $i < count($uids); $i++) {
            imap_delete($mailbox, $uids[$i]);
        }
        imap_expunge($mailbox);
    }

    function SetMailsFlag($mailbox, $mailsUids, $seen = true) {
        if ($seen) imap_setflag_full($mailbox, $mailsUids, '\Seen');
        else imap_clearflag_full($mailbox, $mailsUids, '\Seen');
    }

    function SetMailsFav($mailbox, $mailsUids, $set = true) {
        if ($set) imap_setflag_full($mailbox, $mailsUids, '\Flagged');
        else imap_clearflag_full($mailbox, $mailsUids, '\Flagged');
    }

    function GetUserMailAccounts() {
        $accounts = [];
        $ID = $_SESSION['ID'];
        $db = new DataBase;
        $content = $db->GetCellContent('Users', 'Mails', $ID);
        if ($content) {
            $lines = explode("\n", $content);
            for ($i = 0; $i < count($lines); $i++) {
                $account = explode(',', $lines[$i]);
                array_push($accounts, $account);
            }
        }
        return $accounts;
    }

    function SaveMailAccounts($accounts) {
        $ID = $_SESSION['ID'];
        $save_ID = intval($_POST['save']);
        $content = [];
        for ($acc = 0; $acc < count($accounts); $acc++)
            array_push($content, join(',', $accounts[$acc]));
        $content = join("\n", $content);
        $db = new DataBase;
        $db->SaveCellContent('Users', 'Mails', $ID, $content);
    }

    function AddMailBoxContent($title, $index, $number, $color) {
        echo "<div class='col-lg-3 col-6'>
                <div class='small-box bg-$color'>
                    <div class='inner' style='text-align: center; padding: 2px;'>
                        <h3 style='display: inline;'>$number</h3>
                        <p style='display: inline;'>Mails non lus</p>
                    </div>
                    <div class='icon'>
                        <i class='ion ion-bag'></i>
                    </div>
                    <a onclick=\"LoadPage('mails', {'id': '$index'});\" class='small-box-footer' style='padding: 8px;'>$title <i class='fas fa-arrow-circle-right'></i></a>
                </div>
            </div>";
    }

    function AddMailContent($boxIndex, $mail) {
        global $mailbox, $folder;
    
        $uid = $mail->msgno;
        $name = str_replace("\"", "'", iconv_mime_decode($mail->from, 0, 'UTF-8'));
        $title = str_replace("\"", "'", iconv_mime_decode($mail->subject, 0, 'UTF-8'));
        $seen = $mail->seen;
        $favorite = $mail->flagged;
        $time = dateToFrench(gmdate('Y-M-d H:i:s', $mail->udate), 'd M H:i');

        $attachement = 0;
        $structure = imap_fetchstructure($mailbox, $uid);
        if (isset($structure->parts[0]->parts)) $attachement = 1;

        $fav = $favorite ? "<i class='fas fa-star text-warning'></i>" : "";
        $att = $attachement ? "<i class='fas fa-paperclip'></i>" : "";
        $color_seen = !$seen ? "style='background-color: #646D91 !important;cursor: pointer;'" : "";
        $t1 = substr(explode(':', $time)[0], 0, strlen($time) - 6);
        $t2 = end(explode(' ', $time));
        return "<tr $color_seen>
                    <input type='hidden' value=\"$uid\">
                    <input type='hidden' value=\"$title\">
                    <input type='hidden' value=\"$name\">
                    <input type='hidden' value=\"$time\">
                    <td><input name='mail-check' type='checkbox' value='$uid'></td>
                    <td class='mailbox-star'>$fav</td>
                    <td class='mailbox-name' style='cursor: pointer;' onclick=\"OpenMail($boxIndex, this.parentNode, '$folder');\">$name</td>
                    <td class='mailbox-subject' style='cursor: pointer;' onclick=\"OpenMail($boxIndex, this.parentNode, '$folder');\">$title</td>
                    <td class='mailbox-attachment'>$att</td>
                    <td class='mailbox-date'>$t1 <small>$t2</small></td>
                </tr>";
    }

    function MailsToContent($boxIndex, $mails) {
        global $err;
    
        $output = "";
        if ($mails) {
            foreach ($mails as $mail) {
                if (!$mail->deleted) {
                    $output .= AddMailContent($boxIndex, $mail);
                }
            }
        } else {
            $err = imap_last_error();
        }
        return $output;
    }

    function GetMailBody($mailbox, $uid) {
        $body = getBody($mailbox, $uid);
        if (mb_check_encoding($body) != 'UTF-8')
            $body = utf8_encode($body);
        echo($body);
        exit();
    }

    function getBody($imap, $uid) {
        $body = get_part($imap, $uid, "TEXT/HTML");
        // if HTML body is empty, try getting text body
        if ($body == "") {
            $body = get_part($imap, $uid, "TEXT/PLAIN");
        }
        return $body;
    }

    function get_part($imap, $uid, $mimetype, $structure = false, $partNumber = false) {
        if (!$structure) {
            $structure = imap_fetchstructure($imap, $uid);
        }
        if ($structure) {
            if ($mimetype == get_mime_type($structure)) {
                if (!$partNumber) {
                    $partNumber = 1;
                }
                $text = imap_fetchbody($imap, $uid, $partNumber);
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
            if ($structure->type == 1) {
                foreach ($structure->parts as $index => $subStruct) {
                    $prefix = "";
                    if ($partNumber) {
                        $prefix = $partNumber . ".";
                    }
                    $data = get_part($imap, $uid, $mimetype, $subStruct, $prefix . ($index + 1));
                    if ($data) {
                        return $data;
                    }
                }
            }
        }
        return false;
    }

    function get_mime_type($structure) {
        $primaryMimetype = ["TEXT", "MULTIPART", "MESSAGE", "APPLICATION", "AUDIO", "IMAGE", "VIDEO", "OTHER"];

        if ($structure->subtype) {
            return $primaryMimetype[(int)$structure->type] . "/" . $structure->subtype;
        }
        return "TEXT/PLAIN";
    }

    // Convertit une date ou un timestamp en français
    function dateToFrench($date, $format) {
        $english_days = array('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday');
        $french_days = array('Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche');
        $english_months = array('January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December');
        $french_months = array('Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre');
        return str_replace($english_months, $french_months, str_replace($english_days, $french_days, date($format, strtotime($date))));
    }

    function ShowErrorSection($err, $color) {
        return '
            <section class="col-lg-8" style="margin-left: auto;margin-right: auto;">
                <div class="card card-'.$color.' card-outline">
                    <div class="card-header border-1">
                        <h3 class="card-title"><i class="fas fa-align-left mr-1"></i>Erreur</h3>
                    </div>
                    <div class="card-body" style="padding-bottom: 12px;">
                        <div class="col-10" style="margin: auto;">'.$err.'</div>
                        <div class="card-body p-0 float-right">
                            <ul class="nav nav-pills flex-column">
                                <li class="nav-item">
                                    <a onclick="OpenEditPopup()" class="nav-link">
                                        <i class="fas fa-cog"></i>
                                        Paramètres
                                    </a>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>
            </section>';
    }

    function AddCategory($name, $number) {
        global $account_selected_index, $folder, $main_color;

        $nb = $number > 0 ? $number : '';
        $active = $folder == $name ? "bg-$main_color" : "";

        return "<li class='nav-item $active'>
                    <a class='nav-link' onclick='ChangeView($account_selected_index, 0, \"$name\");'>
                        <i class='fas fa-inbox'></i> $name
                        <span class='badge bg-$main_color float-right' style='margin-top: 4px;'>$nb</span>
                    </a>
                </li>";
    }

?>