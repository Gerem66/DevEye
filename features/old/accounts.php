<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Comptes</h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a href="./user"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item active">Accounts</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">
            <!-- Main content -->

            <?php

                function AddAccountBox($title, $index, $sum, $color) {
                    $i = str_pad($index, 3, '0', STR_PAD_LEFT);
                    $s = number_format($sum, 2);
                    echo "<div class='col-lg-3 col-6'>
                            <div class='small-box $color'>
                            <div class='inner' style='text-align: center; padding: 2px;'>
                                <h3 style='display: inline;'>$s</h3>
                                <p style='display: inline;'>€</p>
                            </div>
                            <div class='icon'>
                                <i class='ion ion-bag'></i>
                            </div>
                            <a href='./accounts-$i' class='small-box-footer' style='padding: 8px;'>$title <i class='fas fa-arrow-circle-right'></i></a>
                            </div>
                        </div>";
                }
                function OpenSection($title, $color, $icon = 'align-left') {
                    $c = str_replace('bg', 'card', $color);
                    echo "<section class='col-lg-12'>
                            <div class='card card-outline $c'>
                                <div class='card-header border-1'>
                                    <h3 class='card-title'><i class='fas fa-$icon mr-1'></i>$title</h3>
                                    <div class='card-tools'>
                                        <button type='button' class='btn $color btn-sm' data-card-widget='collapse' style='margin-right: 8px;'><i class='fas fa-minus'></i></button>
                                        <!--button type='button' class='btn $color btn-sm' data-card-widget='remove'><i class='fas fa-times'></i></button-->
                                    </div>
                                </div>
                                <div class='card-body' style='text-align: center;'>";
                }
                function CloseSection() {
                    echo "</div></div></section>";
                }
                function OpenTable($color) {
                    echo '<div class="col-12">
                            <div class="card">
                                <div class="card-body table-responsive p-0">
                                    <table class="table table-head-fixed table-bordered">
                                        <thead>
                                            <tr>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Juillet</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Août</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Septembre</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Octobre</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Novembre</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Décembre</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Janvier</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Février</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Mars</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Avril</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Mai</th>
                                                <th class="'.$color.'" style="width: 8%; color: white;">Juin</th>
                                            </tr>
                                        </thead>
                                        <tbody>';
                }
                function CloseTable() {
                    echo "</tbody></table></div></div></div>";
                }
                function AddItem($months, $color) {
                    global $bt_id;
                    if (count($months) != 12) {
                        echo "ERROR";
                        return;
                    }
                    echo "<tr style='background: #181a1b; height: 32px;'>";
                    for ($i = 0; $i < 12; $i++) {
                        $m = $months[$i][0];
                        $c = $months[$i][1];
                        echo "<td style='padding: 0px; border: 1px solid black; color: white; background-color: black;'>";
                        $account_id = isset($_GET['id']) ? intval($_GET['id']) : 0;
                        $account_id = $account_id < 10 ? '00'.$account_id : ($account_id < 100 ? '0'.$account_id : $account_id);
                        $id = $bt_id < 10 ? '000'.$bt_id : ($bt_id < 100 ? '00'.$bt_id : ($bt_id < 1000 ? '0'.$bt_id : $bt_id));
                        if (substr($m, 0, 4) == 'ADD-') {
                            echo "<button class='btn btn-block btn-secondary btn-flat disabled' style='cursor: copy;' onmouseover=\"this.classList.toggle('$color');\" onmouseout=\"this.classList.toggle('$color');\" onclick=\"window.location.href='./accounts-$account_id-editcell-$id'\">.</button>";
                            $bt_id++;
                        }
                        else if ($m == '' || $c == '') {
                            echo "<div style='background-color: #444; color: #444; height: 38px;'>.</div>";
                        } else {
                            echo "<div class='tooltip-account bg-info'>
                                        <button class='btn btn-block btn-secondary btn-flat' onmouseover=\"this.classList.toggle('$color');\" onmouseout=\"this.classList.toggle('$color');\" onclick=\"window.location.href='./accounts-$account_id-editcell-$id'\" href=''>$m
                                            <span class='tooltiptext-account $color'>$c</span>
                                        </button>
                                    </div>";
                            $bt_id++;
                        }
                        echo "</td>";
                    }
                    echo "</tr>";
                }
                function AddAccount() {
                    global $savefile;

                    $lines = file_get_contents($savefile)."\r\n";
                    $lines .= "> Compte:bg-primary";
                    $lines .= str_repeat("\r\n", 24);
                    file_put_contents($savefile, $lines);
                    echo "<script>window.location.href = \"./accounts\";</script>";
                }
                function DeleteAccount($id) {
                    global $savefile;

                    $lines = explode("\r\n", file_get_contents($savefile));
                    $fl = $id * 25;
                    for ($i = 0; $i < 25; $i++)
                        unset($lines[$fl + $i]);
                    $lines = array_values($lines);
                    file_put_contents($savefile, join("\r\n", $lines));
                    echo "<script>window.location.href = \"./accounts\";</script>";
                }
                function ChangeName() {
                    global $savefile;

                    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
                    $str_id = isset($_GET['id']) ? $_GET['id'] : '000';
                    $lines = explode("\r\n", file_get_contents($savefile));
                    $lines[$id * 25] = '> ' . $_REQUEST['tb_name'] . ':' . explode(':', $lines[$id * 25])[1];

                    file_put_contents($savefile, join("\r\n", $lines));
                    echo "<script>window.location.href = \"./accounts-$str_id\";</script>";
                }
                function ChangeColor($color) {
                    global $savefile;

                    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
                    $str_id = isset($_GET['id']) ? $_GET['id'] : '000';
                    $lines = explode("\r\n", file_get_contents($savefile));
                    $lines[$id * 25] = explode(':', $lines[$id * 25])[0] . ':' . $color;

                    file_put_contents($savefile, join("\r\n", $lines));
                    echo "<script>window.location.href = \"./accounts-$str_id\";</script>";
                }

                // Init variables
                $_id = 0;
                $ID = $_SESSION['ID'];
                $inst = $_SESSION['INSTANCE'];
                $account_number = 0;
                $savefile = "instances/$inst/$ID/Accounts/accounts";
                $lines = explode("\r\n", file_get_contents($savefile));
                $bt_id = 0;

                $arr = [];
                $coms = [];
                $opened = false;

                // Add Account
                if (isset($_REQUEST['add'])) {
                    AddAccount();
                }
                // Delete Account
                if (isset($_REQUEST['delete'])) {
                    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
                    DeleteAccount($id);
                }
                // Change Name
                if (isset($_REQUEST['changename'])) {
                    ChangeName();
                }
                // Change Color
                $radioboxs = ['rb_primary', 'rb_secondary', 'rb_info', 'rb_success', 'rb_danger', 'rb_indigo', 'rb_purple', 'rb_pink', 'rb_navy', 'rb_lightblue', 'rb_teal', 'rb_cyan', 'rb_dark', 'rb_gray', 'rb_gray', 'rb_light', 'rb_warning', 'rb_white', 'rb_orange' ];
                foreach ($radioboxs as $radiobox) {
                    if (isset($_REQUEST[$radiobox]))
                        ChangeColor(str_replace('rb_', 'bg-', $radiobox));
                }

                // Show all accounts
                echo "<div class='row'>";
                foreach (explode("\r\n", file_get_contents($savefile)) as $line) {
                    if (substr($line, 0, 2) == '> ') {
                        $sum = 0.00;
                        for ($i = 0; $i < 12; $i++)
                            foreach (explode("\t", $lines[$account_number * 25 + $i + 1]) as $num) {
                                if (substr($num, 0, 1) != '#')
                                    $sum += str_replace(',', '.', $num);
                                if (substr($num, 0, 1) == "_")
                                    $sum += str_replace(',', '.', substr($num, 1));
                            }
                        AddAccountBox(explode(':', substr($line, 2, strlen($line) - 2))[0], $_id++, $sum, explode(':', substr($line, 2, strlen($line) - 2))[1]);
                        $account_number++;
                    }
                }
                echo "</div>";

                // Set list of transactions
                $first_line = isset($_GET['id']) && intval($_GET['id']) < $account_number ? intval($_GET['id']) * 25 : 0;
                for ($i = 0; $i < 12; $i++) {
                    $add = [ '06', '07', '08', '09', '10', '11', '00', '01', '02', '03', '04', '05' ][$i];
                    $arr[$i] = !empty($lines[$first_line + $i + 1]) ? array_merge(explode("\t", $lines[$first_line + $i + 1]), ["ADD-$add"]) : ["ADD-$add"];
                }
                for ($i = 0; $i < 12; $i++)
                    $coms[$i] = explode(",", $lines[$first_line + $i + 13]);
                $max = max(count($arr[0]), count($arr[1]), count($arr[2]), count($arr[3]), count($arr[4]), count($arr[5]), count($arr[6]), count($arr[7]), count($arr[8]), count($arr[9]), count($arr[10]), count($arr[11]));
                
                // Show monthly expenses
                OpenSection('Somme des transactions par mois', explode(':', substr($lines[$first_line], 2))[1], 'wallet');
                OpenTable(explode(':', substr($lines[$first_line], 2))[1]);

                echo "<tr>";
                for ($i = 0; $i < 12; $i++)
                {
                    $cnt = 0.00;

                    // Max
                    $total_cnt = 0.00;
                    for ($a = 0; $a < $account_number; $a++) {
                        $fl = $a * 25;
                        $targ_account_year = end(explode(' ', reset(explode(':', $lines[$fl]))));
                        $self_account_year = end(explode(' ', reset(explode(':', $lines[$first_line]))));
                        //echo $targ_account_year.','.$self_account_year.',';
                        if ($self_account_year != $targ_account_year)
                            continue;
                        foreach (explode("\t", $lines[$fl + $i + 1]) as $line)
                            if (!empty($line) && substr($line, 0, 1) != '#')
                                $total_cnt += str_replace(',', '.', $line);
                    }

                    foreach (explode("\t", $lines[$first_line + $i + 1]) as $line)
                        if (!empty($line) && substr($line, 0, 1) != '#')
                            $cnt += str_replace(',', '.', $line);

                    $str_cnt = number_format($cnt, 2, ',', '');
                    echo "<td>$str_cnt/<small>$total_cnt</small></td>";
                }
                echo "</tr>";

                CloseTable();
                CloseSection();

                // Show Account's transactions
                OpenSection('Transactions', explode(':', substr($lines[$first_line], 2))[1], 'euro-sign');
                OpenTable(explode(':', substr($lines[$first_line], 2))[1]);
                for ($i = 0; $i < $max; $i++) {
                    $list = [];
                    for ($m = 0; $m < 12; $m++) {
                        $list[$m][0] = count($arr[$m]) > $i ? $arr[$m][$i] : '';
                        $list[$m][1] = count($coms[$m]) > $i ? $coms[$m][$i] : '';
                    }
                    AddItem($list, explode(':', substr($lines[$first_line], 2))[1]);
                }
                CloseTable();
                CloseSection();

                OpenSection('Gérer le compte', explode(':', substr($lines[$first_line], 2))[1], 'cog');
                $color = explode(':', substr($lines[$first_line], 2))[1];
                $account_name = explode(':', substr($lines[$first_line], 2))[0];

            ?>

            <form action="" method="POST">
                <div class="row">
                    <div class="col-4">
                        <button name="add" class='btn <?= $color ?>' style='width: 256px; padding: 8px; margin-top: 24px;' type="submit">
                            Ajouter un compte <i class='fas fa-plus'></i>
                        </button>
                        <button name="delete" class='btn <?= $color ?>' style='width: 256px; padding: 8px; margin-top: 24px;' type="submit">
                            Supprimer le compte <i class='fas fa-trash'></i>
                        </button>
                    </div>
                    <div class="col-4">
                        <h2>Nom du compte :</h2>
                        <input name="tb_name" type="text" class="form-control" placeholder="Nouveau nom de compte" value="<?= $account_name ?>">
                        <button name="changename" class='btn <?= $color ?>' style='width: 256px; padding: 8px; margin-top: 24px;' type="submit">
                            Modifier le nom du compte</i>
                        </button>
                    </div>
                    <div class="col-1"></div>
                    <div class="col-2">
                        <div class="d-flex">
                            <div class="d-flex flex-wrap mb-3">
                                <input type="submit" name="rb_primary" value="" class="bg-primary elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">  </input>
                                <input type="submit" name="rb_secondary" value="" class="bg-secondary elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;"></input>
                                <input type="submit" name="rb_info" value="" class="bg-info elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">     </input>
                                <input type="submit" name="rb_success" value="" class="bg-success elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">  </input>
                                <input type="submit" name="rb_danger" value="" class="bg-danger elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">   </input>
                                <input type="submit" name="rb_indigo" value="" class="bg-indigo elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">   </input>
                                <input type="submit" name="rb_purple" value="" class="bg-purple elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">   </input>
                                <input type="submit" name="rb_pink" value="" class="bg-pink elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">     </input>
                                <input type="submit" name="rb_navy" value="" class="bg-navy elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">     </input>
                                <input type="submit" name="rb_lightblue" value="" class="bg-lightblue elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;"></input>
                                <input type="submit" name="rb_teal" value="" class="bg-teal elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">     </input>
                                <input type="submit" name="rb_cyan" value="" class="bg-cyan elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">     </input>
                                <input type="submit" name="rb_dark" value="" class="bg-dark elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">     </input>
                                <input type="submit" name="rb_gray" value="" class="bg-gray-dark elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;"></input>
                                <input type="submit" name="rb_gray" value="" class="bg-gray elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">     </input>
                                <input type="submit" name="rb_light" value="" class="bg-light elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">    </input>
                                <input type="submit" name="rb_warning" value="" class="bg-warning elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">  </input>
                                <input type="submit" name="rb_white" value="" class="bg-white elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">    </input>
                                <input type="submit" name="rb_orange" value="" class="bg-orange elevation-2" style="width: 40px; height: 20px; border-radius: 25px; margin-right: 10px; margin-bottom: 10px; opacity: 0.8; cursor: pointer;">   </input>
                            </div>
                        </div>
                    </div>
                </div>
            </form>

            <?php CloseSection(); ?>
            
            <!-- End Main content -->
        </div>
    </div>
</div>