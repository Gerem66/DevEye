<?php

    function AddItemMenu($index, $feature) {
        extract($feature);
        
        $STATUS = $_SESSION['STATUS'];
        $settings = $_SESSION['SETTINGS'];
        $enabled = !$canDisable || $settings == -1 || $settings & (1 << $index);

        if ($STATUS < $minLvl || !$enabled) {
            return null;
        }

        $a_data = $page != "" ? "class='nav-link' data-page='$page' onclick=\"LoadPage('$page');\"" : "";
        $color = !$finished ? 'style="color: red;"' : '';
        $collabIcon = $collab && $_SESSION['INSTANCE_ID'] > 0 ? "<a onclick=\"LoadPage('$page', {'team': 1});\" class='nav-icon collab' title='Instance'><i class='fas fa-users'></i></a>" : '';
        return "<li class='nav-item'>
                    <a name='sidebar-item' $a_data>
                        <i class='nav-icon fas fa-$icon'></i>
                        <p $color>$title</p>
                        $collabIcon
                    </a>
                </li>";
    }

    function AddItemCategory($name) {
        return "<li class='nav-header'>$name</li>";
    }

    function AddDropDown($name) {
        return "<li class=\"nav-item menu-open\">
                    <a href=\"#\" class=\"nav-link\">
                        <p>$name
                            <i class=\"right fas fa-angle-left\"></i>
                        </p>
                    </a>
                    <ul class=\"nav nav-treeview\">";
    }
    function CloseDropDown() {
        return '</ul></li>';
    }

    // Niveaux d'accès :
    // 0 : Invité
    // 1 : Utilisateur
    // 2 : Modérateur
    // 3 : Admin

    $lastCat = "";
    $content = "";
    $isOpened = 0;
    $features = $_SESSION['FEATURES'];
    for ($i = 0; $i < count($features); $i++) {
        $feature_content = AddItemMenu($i, $features[$i]);
        if ($feature_content != null) {
            $cat = $features[$i]['category'];
            if ($cat != $lastCat) {
                $lastCat = $cat;
                if ($isOpened) $content .= CloseDropDown();
                $isOpened = 1;
                $content .= AddDropDown($lastCat);
                //$content .= AddItemCategory($lastCat);
            }
            $content .= $feature_content;
        }
    }
    if ($isOpened) $content .= CloseDropDown();

?>

<a class="homebar" href="./home">
    <img src="dist/img/Oxy.png" alt="Oxy logo" />
    <span>Oxy Gestion</span>
</a>

<nav class="topbar">
    <a><i class="icon icon-menu"></i></a>
</nav>

<nav class="sidebar">
    <div class="user-panel" name="sidebar-item" data-page="user">
        <img src="dist/img/<?= $_SESSION['PHOTO']; ?>" alt="User Image">
        <span class="d-block a"><?= $_SESSION["USERNAME"] ?></span>
    </div>

    <ul class="">
        <?= $content ?>
    </ul>
</nav>