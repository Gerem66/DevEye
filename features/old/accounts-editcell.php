<?php
    if (!isset($_GET['id']) || !isset($_GET['n'])) {
        echo "<script>window.location.href = './accounts';</script>";
    }

    session_start();

    function transposeData($data) {
        $retData = array();
        foreach ($data as $row => $columns) {
            foreach ($columns as $row2 => $column2) {
                $retData[$row2][$row] = $column2;
            }
        }
        return $retData;
    }

    $ID = $_SESSION['ID'];
    $inst = $_SESSION['INSTANCE'];
    $savefile = "instances/$inst/$ID/Accounts/accounts";
    $id = intval($_GET['id']);
    $n = intval($_GET['n']);

    $lines = explode("\r\n", file_get_contents($savefile));
    $first_line = $id * 25;
    $account_name = explode(':', substr($lines[$first_line], 2))[0];
    $color = explode(':', substr($lines[$first_line], 2))[1];

    // Load Prices
    $array_init_prices = [];
    for ($i = 0; $i < 12; $i++)
        $array_init_prices[$i] = !empty($lines[$first_line + $i + 1]) ? array_merge(explode("\t", $lines[$first_line + $i + 1]), ["ADD-$i"]) : ["ADD-$i"];
    $array_init_prices = transposeData($array_init_prices);
    $array_prices = [];
    foreach ($array_init_prices as $b)
        foreach ($b as $c)
            array_push($array_prices, $c);
    // Load Comments
    $array_init_comments = [];
    for ($i = 0; $i < 12; $i++)
        $array_init_comments[$i] = !empty($lines[$first_line + $i + 13]) ? array_merge(explode(",", $lines[$first_line + $i + 13]), ["ADD-$i"]) : ["ADD-$i"];
    $array_init_comments = transposeData($array_init_comments);
    $array_comments = [];
    foreach ($array_init_comments as $b)
        foreach ($b as $c)
            array_push($array_comments, $c);

    // Set UI Vars
    $money = substr($array_prices[$n], 0, 4) != 'ADD-' ? $array_prices[$n] : '00,00';
    $description = substr($array_comments[$n], 0, 4) != 'ADD-' ? $array_comments[$n] : '';

    // Save
    if (isset($_REQUEST['save'])) {
        // $id
        // $first_line
        // $lines

        $new_price = number_format(floatval(str_replace(',', '.', $_REQUEST['price'])), 2, ',', '');
        $new_description = $_REQUEST['description'];

        // Add new entry
        if (substr($array_prices[$n], 0, 4) == 'ADD-') {
            $mod_line = intval(explode('-', $array_prices[$n])[1]);
            $sep1 = !empty($lines[$first_line + $mod_line + 1]) ? "\t" : "";
            $sep2 = !empty($lines[$first_line + $mod_line + 13]) ? "," : "";
            $lines[$first_line + $mod_line + 1]  .= $sep1.$new_price;
            $lines[$first_line + $mod_line + 13] .= $sep2.$new_description;
        } else {
            // Change price
            $_n = 0;
            $i = 0;
            $j = 0;
            for (; $i < 99999; $i++) {
                for ($j = 0; $j < 12; $j++) {
                    $nb = empty($lines[$first_line + $j + 1]) ? 1 : count(explode("\t", $lines[$first_line + $j + 1])) + 1;
                    if ($nb > $i)
                        $_n++;
                    if ($_n > $n)
                        break;
                }
                if ($_n > $n)
                    break;
            }
            $lines[$first_line + $j + 1] = join("\t", array_replace(explode("\t", $lines[$first_line + $j + 1]), array($i => $new_price)));
            $lines[$first_line + $j + 13] = join(",", array_replace(explode(",", $lines[$first_line + $j + 13]), array($i => $new_description)));
        }
        file_put_contents($savefile, join("\r\n", $lines));
        $i = $_GET['id'];
        echo "<script>window.location.href = \"./accounts-$i\";</script>";
    }
?>

<div class="content-wrapper">
    <div class="content-header">
        <div class="container-fluid">
            <div class="row mb-2">
                <div class="col-sm-6">
                    <h1 class="m-0 text">Compte - <?= $account_name ?></h1>
                </div>
                <div class="col-sm-6">
                    <ol class="breadcrumb float-sm-right">
                        <li class="breadcrumb-item"><a href="./user"><?= $_SESSION['USERNAME']; ?></a></li>
                        <li class="breadcrumb-item"><a href="./accounts">Accounts</a></li>
                        <li class="breadcrumb-item active">accounts-editcell</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>

    <div class="content">
        <div class="container-fluid">
            <!-- Main content -->

            <div class="row">
                <div class="col-2"></div>
                <div class="card <?= str_replace('bg', 'card', $color) ?> col-8">
                    <div class="card-header">
                        <a class="float-left fas fa-arrow-left" style="margin-right: 24px;" href="./accounts-<?= $_GET['id'] ?>"></a>
                        <h3 class="card-title">Edition d'un élément</h3>
                    </div>
                    <div class="card-body">
                        
                        <div class="row">
                            <div class="col-sm-3">
                                <label>Argent</label>
                            </div>
                            <div class="col-sm-9">
                                <div class="form-group">
                                    <label>Contexte</label>
                                </div>
                            </div>
                        </div>

                        <form action="" method="POST" autocomplete="off">
                            <div class="row">
                                <div class="col-sm-3">
                                    <div class="input-group mb-3">
                                        <input type="text" id="price" name="price" class="form-control" style="text-align: right;" placeholder="00,00" value="<?= $money ?>" required>
                                        <div class="input-group-append">
                                            <span class="input-group-text"><i class="fas fa-euro-sign"></i></span>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-sm-7">
                                    <input type="text" name="description" class="form-control" placeholder="ex: 18 : Courses alimentaires..." value="<?= $description ?>" required>
                                </div>
                                <div class="col-sm-2">
                                    <button type="submit" name="save" class="btn <?= $color ?> btn-sm">Sauvegarder</button>
                                </div>
                            </div>
                        </form>

                    </div>
                </div>
            </div>
            
            <!-- End Main content -->
        </div>
    </div>
</div>