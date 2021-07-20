<?php

    function AddItemMenu($index, $feature) {
        extract($feature);
        
        $STATUS = $_SESSION['STATUS'];
        $settings = $_SESSION['SETTINGS'];
        $enabled = !$canDisable || $settings == -1 || $settings & (1 << $index);

        if ($STATUS < $minLvl || !$enabled) return;

        $color = !$finished ? 'style="color: red;"' : '';
        $collabIcon = $collab && $_SESSION['INSTANCE_ID'] > 0 ? "<a onclick=\"LoadPage('$page', {'team': 1});\" class='nav-icon collab' title='Instance'><i class='fas fa-users'></i></a>" : '';
        return "<li class='nav-item'>
                    <a name='sidebar-item' data-page='$page' onclick=\"LoadPage('$page');\" class='nav-link'>
                        <i class='nav-icon fas fa-$icon'></i>
                        <p $color>$title</p>
                        $collabIcon
                    </a>
                </li>";
    }

    // Niveaux d'accès :
    // 0 : Invité
    // 1 : Utilisateur
    // 2 : Modérateur
    // 3 : Développeur

    $content = "";
    $features = $_SESSION['FEATURES'];
    for ($i = 0; $i < count($features); $i++) {
        $content .= AddItemMenu($i, $features[$i]);
    }

?>

<!-- Topbar -->
<nav class="main-header navbar navbar-expand navbar-black navbar-dark">
    <ul class="navbar-nav">
        <li class="nav-item">
            <a class="nav-link" data-widget="pushmenu" role="button"><i class="fas fa-bars"></i></a>
        </li>
    </ul>
    <ul class="navbar-nav ml-auto">
        <!--li class="nav-item bg-primary">
            <a class="btn" style="width: 128px; background-color: #444;border-radius: 0;" href="http://geremy.eu/Projects"><img src="dist/img/logo.png" style="background-color: #444;" width="36px"></img> Projects</a>
        </li-->
        <li class="nav-item">
            <a class="nav-link" data-widget="control-sidebar" data-slide="true" role="button"><i class="fas fa-th-large"></i></a>
        </li>
    </ul>
</nav>

<!-- Main Sidebar Container -->
<aside class="main-sidebar sidebar-dark-primary elevation-4">
    <!-- Brand Logo -->
    <a href="./accueil" class="brand-link">
        <img src="dist/img/OxyLogo.png" alt="Oxy Logo" class="brand-image img-circle elevation-3"
            style="opacity: .8">
        <span class="brand-text font-weight-light">Oxy Foo</span>
    </a>

    <!-- Sidebar -->
    <div class="sidebar">
        <div name='sidebar-item' class="user-panel mt-3 pb-3 mb-3 d-flex item-user a" data-page="user" onclick="LoadPage('user');">
            <div class="image">
                <img src="dist/img/<?= $_SESSION['PHOTO']; ?>" class="img-circle elevation-2" alt="User Image">
            </div>
            <div class="info">
                <a class="d-block"><?= $_SESSION["USERNAME"] ?></a>
            </div>
        </div>

        <!-- Sidebar Menu -->
        <nav class="mt-2">
            <ul class="nav nav-pills nav-sidebar flex-column" data-widget="treeview" role="menu" data-accordion="false">
                <?= $content ?>
            </ul>
        </nav>
    </div>
</aside>