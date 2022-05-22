<?php

    session_start();
    date_default_timezone_set('Europe/Paris');
    setlocale(LC_TIME, 'fr_FR.utf8', 'fra');

    require('dist/php/class/feature.php');
    require('dist/php/class/instance.php');
    require('dist/php/class/project.php');
    require('dist/php/class/user.php');

    require('dist/php/sql/sql.php');
    require('dist/php/user.php');
    require('dist/php/roles.php');
    require('dist/php/utils.php');
    require('dist/php/sidebar.php');

    $db = new DataBase();
    $connected = isset($_SESSION['USER_ID']);
    $version = '0.0.1';

    // Connection
    if (array_key_exists('bt_connect', $_POST)) {
        $connected = Connect($db);
    }

    // Redirect if unconnected
    if (!$connected) {
        $_SESSION['CONNECTED'] = -1;
        header('Location: ./');
        exit();
    }

    $rawUser = $db->GetRowContent('Users', 'ID', $_SESSION['USER_ID']);
    $user = User::Load($rawUser);

    // Load
    $sidebar = GenerateSidebar($db, $user);
    $scriptsJS = GetScriptsFiles('features/', 'js');
    $scriptsCSS = GetScriptsFiles('features/', 'css');
    $scriptsMerge = array_merge($scriptsCSS, $scriptsJS);
    $scripts = implode('', array_map('GetScriptsImports', $scriptsMerge));

    // Load home variables and render
    $commandJS = '';
    if (array_key_exists('default', $user->Settings)) {
        $rawFeature = $db->GetRowContent('Features', 'ID', $user->Settings['default']);
        $feature = Feature::Load($rawFeature);
        $correctLevel = $feature->Level <= $user->Level;
        $enabled = $feature->EnabledDefault;
        if (array_key_exists($feature->ID, $user->Settings)) {
            $enabled = $user->Settings[$feature->ID];
        }
        if ($feature !== null && $correctLevel && $enabled) {
            $commandJS = "<script>page.defaultPage = '{$feature->Redirect}'</script>";
        }
    }
    $variables = array(
        'sidebar' => $sidebar,
        'version' => $version,
        'avatar' => $user->Avatar,
        'username' => $user->Username,
        'scripts' => $scripts,
        'commandJS' => $commandJS
    );

    $content = ImportHTML('dist/html/home.html', $variables);
    echo($content);

?>