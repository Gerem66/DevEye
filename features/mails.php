<?php

    require("dist/php/mails.php");

    if (isset($_REQUEST['delete'])) RemoveMailBox();
    if (isset($_REQUEST['save'])) SaveMailBox();

    // Init all variables
    $err = "";
    $main_color = 'blue';

    $accounts = GetUserMailAccounts();
    $accounts_length = count($accounts);

    $account_selected_index = min(intval($post_id), $accounts_length-1);
    $folder = GetPostValue('folder', 'INBOX');

    // Get mails
    $mail_length = 0;
    if ($accounts_length > 0) {
        list($title, $server, $mail, $password, $main_color, $unseen) = $accounts[$account_selected_index];

        if (empty($title) || empty($server) || empty($mail) || empty($password)) {
            $err = 'Vous devez remplir tous les champs.';
        } else if (strpos($server, '}') !== false && strpos(explode('}', $server)[1], '/') !== false) {
            $err = 'Veuillez retirer le répertoire du serveur (ex : "/INBOX").';
        } else {
            $mailbox = imap_open($server.$folder, $mail, $password);
            if (isset($_REQUEST['read'])) GetMailBody($mailbox, intval($_REQUEST['read']));
            if (isset($_REQUEST['expunge'])) RemoveMails($mailbox, $_REQUEST['expunge']);
            if (isset($_REQUEST['seen'])) SetMailsFlag($mailbox, $_REQUEST['seen'], true);
            if (isset($_REQUEST['unseen'])) SetMailsFlag($mailbox, $_REQUEST['unseen'], false);
            if (isset($_REQUEST['fav'])) SetMailsFav($mailbox, $_REQUEST['fav'], true);
            if (isset($_REQUEST['unfav'])) SetMailsFav($mailbox, $_REQUEST['unfav'], false);

            $mails = FALSE;
            if ($mailbox) {
                $info = imap_check($mailbox);
                $mail_length = $info->Nmsgs;

                $mail_view_index = GetPostValue('view', 0);
                $mail_view_length = 20;
                $mail_view_index_max = floor($mail_length / $mail_view_length);
                $mail_view_first = $mail_view_index * $mail_view_length;
                $mail_view_last = $mail_view_first + $mail_view_length;

                if ($mail_view_first > $mail_length) {
                    $mail_view_index = 0;
                    $mail_view_last = $mail_view_first + $mail_view_length - 1;
                } else if ($mail_view_last > $mail_length) {
                    $mail_view_last = $mail_length - 1;
                }

                if ($info) {
                    $start = $mail_length - $mail_view_first;
                    $end = $mail_length - $mail_view_last;
                    $mails = imap_fetch_overview($mailbox, "$start:$end", 0);
                    $mails = array_reverse($mails);
                } else {
                    $err = 'Impossible de lire le contenu de la boite mail';
                }
            } else {
                $err = imap_last_error();
            }

            $inbox_raw = imap_list($mailbox, $server, "*");
            $inbox_content = AddCategory('INBOX', imap_status($mailbox, $server.'INBOX', SA_UNSEEN)->unseen);
            for ($i = 0; $i < count($inbox_raw); $i++) {
                $name = substr($inbox_raw[$i], strlen($server));
                $next = $i < count($inbox_raw) - 1 ? substr($inbox_raw[$i+1], strlen($server)) : '';
                if (strpos($name, '/') === false && strpos($next, '/') === false && $name != 'INBOX')
                    $inbox_content .= AddCategory($name, imap_status($mailbox, $server.$name, SA_UNSEEN)->unseen);
            }

            $allMails = $mail_length > 0 ? MailsToContent($account_selected_index, $mails) : '';
            if ($mail_view_index == 0 && $folder == 'INBOX') {
                $status = imap_status($mailbox, $server.$folder, SA_UNSEEN);
                $accounts[$account_selected_index][5] = $status->unseen;
                SaveMailAccounts($accounts);
            }

            imap_close($mailbox);
        }
    }

?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Boîtes mails
                        <a class="btn fbtn bg-<?= $main_color ?>" onclick="OpenCreatePopup();">Ajouter une boîte mail</a>
                    </h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a onclick="LoadPage('user');"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">Mails</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <section id="popup-mail" class="popup content-wrapper">
        <div class="popup-card">
            <h1 id="popup-title">Édition de la boîte mail</h1>
            <input name="tb_id" type="hidden" class="form-control" value="<?= $account_selected_index ?>" readonly>
            <input name="tb_title" type="text" class="form-control" placeholder="Nom du mail" value="<?= $title ?>">

            <div style="display: inline-flex; width: 30%; margin: 1rem;">
                <div class="input-group">
                    <input name="tb_server" type="text" class="form-control" placeholder="Serveur" value="<?= $server ?>">
                    <div class="input-group-prepend">
                        <button type="button" class="btn bg-<?= $main_color ?> dropdown-toggle" data-toggle="dropdown" aria-expanded="false" style="border-top-right-radius: 0.25rem; border-bottom-right-radius: 0.25rem;"></button>
                        <ul class="dropdown-menu" style="">
                            <li class="dropdown-item" onclick="SetServer(0, '{imap.gmail.com:993/imap/ssl/novalidate-cert}');">Google</li>
                            <li class="dropdown-item" onclick="SetServer(0, '{imap.mail.me.com:993/imap/ssl/novalidate-cert}');">iCloud</li>
                            <li class="dropdown-item" onclick="SetServer(0, '{imap.outlook.office365.com:993/imap/ssl/novalidate-cert}');">Outlook</li>
                            <li class="dropdown-item" onclick="SetServer(0, '{imap.mail.yahoo.com:993/imap/ssl/novalidate-cert}');">Yahoo</li>
                            <li class="dropdown-divider"></li>
                            <li class="dropdown-item" onclick="SetServer(0);">Clear</li>
                        </ul>
                    </div>
                </div>
            </div>

            <input name="tb_mail" type="email" class="form-control" placeholder="Adresse Mail" value="<?= $mail ?>">

            <div style="display: inline-flex; width: 30%; margin: 1rem;">
                <div class="input-group">
                    <input name="tb_password" type="password" class="form-control" placeholder="Mot de passe" value="<?= $password ?>">
                    <div class="input-group-prepend">
                        <button type="button" class="btn bg-<?= $main_color ?>" onclick="SwitchPasswordVision(this);" style="border-top-right-radius: 0.25rem; border-bottom-right-radius: 0.25rem; padding: 0; width: 34px"><i class="far fa-eye-slash"></i></button>
                    </div>
                </div>
            </div>


            <select name="tb_color" class="form-control custom-select" style="display: inline; width: 30%; margin: 1rem;">
                <option selected="" disabled="">Sélectionnez une couleur</option>
                <option class="bg-primary" <?= $main_color == "primary" ? 'selected' : '' ?> value="primary">Bleu</option>
                <option class="bg-secondary" <?= $main_color == "secondary" ? 'selected' : '' ?> value="secondary">Gris</option>
                <option class="bg-success" <?= $main_color == "success" ? 'selected' : '' ?> value="success">Vert</option>
                <option class="bg-info" <?= $main_color == "info" ? 'selected' : '' ?> value="info">Turquoise</option>
                <option class="bg-danger" <?= $main_color == "danger" ? 'selected' : '' ?> value="danger">Rouge</option>
                <option class="bg-indigo" <?= $main_color == "indigo" ? 'selected' : '' ?> value="indigo">Indigo</option>
                <option class="bg-navy" <?= $main_color == "navy" ? 'selected' : '' ?> value="navy">Bleu Marine</option>
                <option class="bg-lightblue" <?= $main_color == "lightblue" ? 'selected' : '' ?> value="lightblue">Bleu clair</option>
                <option class="bg-teal" <?= $main_color == "teal" ? 'selected' : '' ?> value="teal">Vert Clair</option>
                <option class="bg-cyan" <?= $main_color == "cyan" ? 'selected' : '' ?> value="cyan">Cyan</option>
                <option class="bg-yellow" <?= $main_color == "yellow" ? 'selected' : '' ?> value="yellow">Jaune</option>
                <option class="bg-orange" <?= $main_color == "orange" ? 'selected' : '' ?> value="orange">Orange</option>
                <option class="bg-light" <?= $main_color == "light" ? 'selected' : '' ?> value="light">Blanc</option>
            </select>
            <a class='btn bg-<?= $main_color ?> btn-inline' style='width: 30%; margin: 1rem;' onclick='Delete();'>Supprimer cette boîte mail</a>
            <br />
            <button name="back" class="btn btn-dark btn-lg" style="width: 20%; margin: 24px;">
                Retour
            </button>
            <button name="save" class="btn bg-<?= $main_color ?> btn-lg" style="width: 20%; margin: 24px;">
                Sauvegarder
            </button>
        </div>
    </section>

    <section id="popup-mail-create" class="popup content-wrapper">
        <div class="popup-card">
            <h1 id="popup-title-create">Ajouter une boîte mail</h1>
            <input name="tb_id" type="hidden" class="form-control" value="<?= $accounts_length ?>" readonly>
            <input name="tb_title" type="text" class="form-control" placeholder="Nom du mail" value="">

            <div style="display: inline-flex; width: 30%; margin: 1rem;">
                <div class="input-group">
                    <input name="tb_server" type="text" class="form-control" placeholder="Serveur" value="">
                    <div class="input-group-prepend">
                        <button type="button" class="btn bg-<?= $main_color ?> dropdown-toggle" data-toggle="dropdown" aria-expanded="false" style="border-top-right-radius: 0.25rem; border-bottom-right-radius: 0.25rem;"></button>
                        <ul class="dropdown-menu" style="">
                            <li class="dropdown-item" onclick="SetServer(1, '{imap.gmail.com:993/imap/ssl/novalidate-cert}');">Google</li>
                            <li class="dropdown-item" onclick="SetServer(1, '{imap.mail.me.com:993/imap/ssl/novalidate-cert}');">iCloud</li>
                            <li class="dropdown-item" onclick="SetServer(1, '{imap.outlook.office365.com:993/imap/ssl/novalidate-cert}');">Outlook</li>
                            <li class="dropdown-item" onclick="SetServer(1, '{imap.mail.yahoo.com:993/imap/ssl/novalidate-cert}');">Yahoo</li>
                            <li class="dropdown-divider"></li>
                            <li class="dropdown-item" onclick="SetServer(1);">Clear</li>
                        </ul>
                    </div>
                </div>
            </div>
            
            <input name="tb_mail" type="email" class="form-control" placeholder="Adresse Mail" value="">

            <div style="display: inline-flex; width: 30%; margin: 1rem;">
                <div class="input-group">
                    <input name="tb_password" type="password" class="form-control" placeholder="Mot de passe" value="">
                    <div class="input-group-prepend">
                        <button type="button" class="btn bg-<?= $main_color ?>" onclick="SwitchPasswordVision(this);" style="border-top-right-radius: 0.25rem; border-bottom-right-radius: 0.25rem; padding: 0; width: 34px"><i class="far fa-eye-slash"></i></button>
                    </div>
                </div>
            </div>

            <select name="tb_color" class="form-control custom-select" style="display: inline; width: 30%; margin: 1rem;">
                <option selected="" disabled="">Sélectionnez une couleur</option>
                <option class="bg-primary" value="primary" selected>Bleu</option>
                <option class="bg-secondary" value="secondary">Gris</option>
                <option class="bg-success" value="success">Vert</option>
                <option class="bg-info" value="info">Turquoise</option>
                <option class="bg-danger" value="danger">Rouge</option>
                <option class="bg-indigo" value="indigo">Indigo</option>
                <option class="bg-navy" value="navy">Bleu Marine</option>
                <option class="bg-lightblue" value="lightblue">Bleu clair</option>
                <option class="bg-teal" value="teal">Vert Clair</option>
                <option class="bg-cyan" value="cyan">Cyan</option>
                <option class="bg-yellow" value="yellow">Jaune</option>
                <option class="bg-orange" value="orange">Orange</option>
                <option class="bg-light" value="light">Blanc</option>
            </select>
            <br />
            <button name="back" class="btn btn-dark btn-lg" style="margin-top: 24px;">
                Retour
            </button>
            <button name="save" class="btn bg-<?= $main_color ?> btn-lg" style="margin-top: 24px;">
                Ajouter
            </button>
        </div>
    </section>

    <section id="popup-mail-read" class="popup content-wrapper">
        <div class="col-md-9">
            <div class="card card-primary card-outline">
                <div class="card-header">
                    <h3 id="mail-read-subject" class="card-title">Mail</h3>
                </div>
                <div class="card-body p-0">
                    <div class="mailbox-read-info">
                        <span id="mail-read-date" class="mailbox-read-time float-right">15 Feb. 2015 11:03 PM</span>
                        <h6 id="mail-read-from" style="margin-left: 12px;">De:</h6>
                    </div>
                    <div class="card-footer">
                        <div class="float-right">
                            <!--button type="button" class="btn btn-default"><i class="fas fa-reply"></i> Répondre</button-->
                            <button id="mail-read-delete" type="button" class="btn btn-default"><i class="far fa-trash-alt"></i> Supprimer</button>
                        </div>
                        <button id="mail-read-back" type="button" class="btn btn-default"><i class="fas fa-reply"></i> Retour</button>
                    </div>
                    <div id="mail-read-body" class="mailbox-read-message" style="height: 60vh; overflow: scroll;"></div>
                </div>
            </div>
        </div>
    </section>

    <div class="content">
        <div class="container-fluid">
            <!-- Main content -->

            <?php

                echo("<div class='row'>");
                for ($i = 0; $i < $accounts_length; $i++) {
                    list($_title, $_server, $_mail, $_password, $_color, $_unseen) = $accounts[$i];
                    AddMailBoxContent($_title, $i, $_unseen, $_color == '' ? 'blue' : $_color);
                }
                echo("</div>");

                if ($err != "") {
                    echo(ShowErrorSection($err, $main_color));
                    exit();
                }

                if ($accounts_length <= 0) exit();

            ?>

            <!-- Main content -->
            <section class="content">
                <div class="row">
                    <div class="col-md-2">
                        <!--a class="btn bg-<?= "dark"//$main_color ?> btn-block mb-3">Compose</a-->

                        <div class="card">
                            <div class="card-header">
                                <h3 class="card-title">Gérer le compte</h3>

                                <div class="card-tools">
                                    <button type="button" class="btn btn-tool" data-card-widget="collapse"><i class="fas fa-minus"></i>
                                    </button>
                                </div>
                            </div>
                            <div class="card-body p-0">
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

                        <div class="card">
                            <div class="card-header">
                                <h3 class="card-title">Dossiers</h3>

                                <div class="card-tools">
                                    <button type="button" class="btn btn-tool" data-card-widget="collapse"><i class="fas fa-minus"></i>
                                    </button>
                                </div>
                            </div>

                            <div class='card-body p-0'>
                                <ul class='nav nav-pills flex-column'>
                                    <?= $inbox_content ?>
                                </ul>
                            </div>
                        </div>
                    </div>
        
                    <div class="col-md-10">
                        <div class="card card-<?= $main_color ?> card-outline">
                            <div class="card-header">
                                <h3 class="card-title"><?= $title ?></h3>

                                <div class="card-tools">
                                    <div class="input-group input-group-sm">
                                        <!--input type="text" class="form-control" placeholder="Search Mail">
                                        <div class="input-group-append">
                                            <div class="btn btn-<?= $main_color ?>">
                                                <i class="fas fa-search"></i>
                                            </div>
                                        </div-->
                                    </div>
                                </div>
                            </div>
                            <div class="card-body p-0">
                                <div class="mailbox-controls">
                                    <button name="checkall" type="button" class="btn btn-default btn-sm checkbox-toggle" onclick="SwitchSelection();">
                                        <input type="checkbox" style="pointer-events: none;">
                                    </button>
                                    <div class="btn-group">
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme non lu" onclick="SetMailsFlag(<?= $account_selected_index ?>, -1, '<?= $folder ?>', false);">
                                            <i class="fas fa-envelope"></i>
                                        </button>
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme lu" onclick="SetMailsFlag(<?= $account_selected_index ?>, -1, '<?= $folder ?>', true);">
                                            <i class="far fa-envelope-open"></i>
                                        </button>
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme non favori" onclick="SetMailsFav(<?= $account_selected_index ?>, -1, '<?= $folder ?>', false);">
                                            <i class="fas fa-star"></i>
                                        </button>
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme favori" onclick="SetMailsFav(<?= $account_selected_index ?>, -1, '<?= $folder ?>', true);">
                                            <i class="far fa-star"></i>
                                        </button>
                                    </div>
                                    <button type="button" class="btn btn-default btn-sm" onclick="RemoveMail(<?= $account_selected_index ?>, -1, '<?= $folder ?>');"><i class="far fa-trash-alt"></i></button>
                                    <button type="button" class="btn btn-default btn-sm" onclick="ChangeView(<?= $account_selected_index ?>, <?= $mail_view_index ?>, '<?= $folder ?>');"><i class="fas fa-sync-alt"></i></button>
                                    <div class="float-right">
                                        <?= $mail_view_first ?>-<?= $mail_view_last ?>/<?= $mail_length-1 ?>
                                        <div class="btn-group">
                                            <button type="button" class="btn btn-default btn-sm" onclick="ChangeView(<?= $account_selected_index ?>, <?= max($mail_view_index - 1, 0) ?>, '<?= $folder ?>');"><i class="fas fa-chevron-left"></i></button>
                                            <button type="button" class="btn btn-default btn-sm" onclick="ChangeView(<?= $account_selected_index ?>, <?= min($mail_view_index + 1, $mail_view_index_max) ?>, '<?= $folder ?>');"><i class="fas fa-chevron-right"></i></button>
                                        </div>
                                    </div>
                                </div>
                                <div class="table-responsive mailbox-messages">
                                    <table class="table table-hover table-striped">
                                        <thead>
                                            <tr>
                                                <th style="width: 2%;"></th>
                                                <th style="width: 2%;">Fav</th>
                                                <th>Correspondant</th>
                                                <th>Sujet</th>
                                                <th style="width: 2%;"></th>
                                                <th style="width: 12%;">Date</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <?= $allMails ?>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <div class="card-footer p-0">
                                <div class="mailbox-controls">
                                    <button name="checkall" type="button" class="btn btn-default btn-sm checkbox-toggle" onclick="SwitchSelection();">
                                        <input type="checkbox" style="pointer-events: none;">
                                    </button>
                                    <div class="btn-group">
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme non lu" onclick="SetMailsFlag(<?= $account_selected_index ?>, -1, '<?= $folder ?>', false);">
                                            <i class="fas fa-envelope"></i>
                                        </button>
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme lu" onclick="SetMailsFlag(<?= $account_selected_index ?>, -1, '<?= $folder ?>', true);">
                                            <i class="far fa-envelope-open"></i>
                                        </button>
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme non favori" onclick="SetMailsFav(<?= $account_selected_index ?>, -1, '<?= $folder ?>', false);">
                                            <i class="fas fa-star"></i>
                                        </button>
                                        <button type="button" class="btn btn-default btn-sm" title="Marquer comme favori" onclick="SetMailsFav(<?= $account_selected_index ?>, -1, '<?= $folder ?>', true);">
                                            <i class="far fa-star"></i>
                                        </button>
                                    </div>
                                    <button type="button" class="btn btn-default btn-sm" onclick="RemoveMail(<?= $account_selected_index ?>, -1, '<?= $folder ?>');"><i class="far fa-trash-alt"></i></button>
                                    <button type="button" class="btn btn-default btn-sm" onclick="ChangeView(<?= $account_selected_index ?>, <?= $mail_view_index ?>, '<?= $folder ?>');"><i class="fas fa-sync-alt"></i></button>
                                    <div class="float-right">
                                        <?= $mail_view_first ?>-<?= $mail_view_last ?>/<?= $mail_length-1 ?>
                                        <div class="btn-group">
                                            <button type="button" class="btn btn-default btn-sm" onclick="ChangeView(<?= $account_selected_index ?>, <?= max($mail_view_index - 1, 0) ?>, '<?= $folder ?>');"><i class="fas fa-chevron-left"></i></button>
                                            <button type="button" class="btn btn-default btn-sm" onclick="ChangeView(<?= $account_selected_index ?>, <?= min($mail_view_index + 1, $mail_view_index_max) ?>, '<?= $folder ?>');"><i class="fas fa-chevron-right"></i></button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- End Main content -->
        </div>
    </div>
</div>