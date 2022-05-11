<?php

    function OpenInstance($name) {
        return "<li class='instance'>
                    <p>$name</p>
                    <ul>";
    }
    function CloseInstance() {
        return '</ul></li>';
    }

    function AddButtonFeature($feature, $category) {
        global $ALL_FEATURES;
        extract($ALL_FEATURES[$feature]);

        $data_page = '';
        if ($page !== '') {
            $data_page = " data-category=\"$category\" data-page=\"$page\"";
        }
        return "<li class='feature' name='sidebar-item'$data_page>
                    <a class='title-item'>
                        <span class='icon icon-$icon'></span>
                        <p>$title</p>
                    </a>
                </li>";
    }

    function OpenGroupFeature($feature) {
        global $ALL_GROUP_FEATURES;
        extract($ALL_GROUP_FEATURES[$feature]);

        return "<li class='group-feature' name='sidebar-group'>
                    <a class='title-item'>
                        <span class='icon icon-$icon'></span>
                        <p>$title</p>
                        <span class='icon icon-chevron'></span>
                    </a>
                    <ul>";
    }
    function CloseGroupFeature() {
        return '</ul></li>';
    }

    function AddButtonSubFeature($feature, $category) {
        global $ALL_FEATURES;
        extract($ALL_FEATURES[$feature]);

        $data_page = '';
        if ($page !== '') {
            $data_page = " data-category=\"$category\" data-page=\"$page\"";
        }
        return "<li class='sub-feature' name='sidebar-item'$data_page>
                    <a>
                        <span class='icon icon-$icon'></span>
                        <p>$title</p>
                    </a>
                </li>";
    }

    function GenerateSidebar($features, $category = null, $level = 0) {
        $content = '';
        foreach ($features as $key => $value) {
            $keyType = gettype($key);
            if ($keyType === 'integer') {
                // New feature or subfeature (button)
                if ($level === 0 || $level === 1) {
                    $content .= AddButtonFeature($value, $category);
                } else {
                    $content .= AddButtonSubFeature($value, $category);
                }
            } else {
                // New category (ul/li)
                if ($level === 0) {
                    $content .= OpenInstance($key);
                    $content .= GenerateSidebar($value, $key, $level + 1);
                    $content .= CloseInstance();
                } else {
                    $content .= OpenGroupFeature($key);
                    $content .= GenerateSidebar($value, $key, $level + 1);
                    $content .= CloseGroupFeature();
                }
            }
        }
        return $content;
    }

    $features = $_SESSION['FEATURES'];
    $content = GenerateSidebar($features);

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
        <a>
            <img src="dist/img/<?= $_SESSION['PHOTO']; ?>" alt="User Image">
            <span class="d-block a"><?= $_SESSION["USERNAME"] ?></span>
        </a>
    </div>

    <ul>
        <?= $content ?>
    </ul>
</nav>