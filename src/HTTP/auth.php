<?php

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST");
header("Access-Control-Allow-Headers: Content-Type");

require_once(__DIR__.'/utils.php');
require_once(__DIR__.'/PHP-SQL/sql.php');

require_once(__DIR__.'/class/user.php');
//require_once(__DIR__.'/class/context.php');
//require_once(__DIR__.'/class/instance.php');
//require_once(__DIR__.'/class/feature.php');

// Initialize the database
$db = new DataBase();

// Get the input data
$input = file_get_contents('php://input');
$data = json_decode($input, true);

$username = $data['username'];
$password = $data['password'];
if (!isset($username, $password)) {
    // Try to reverse engineer the input ?
    // TODO: Généraliser
    AddLog($db, 0, 2, 'hack', 'Enpoint /auth - Invalid input data');
    exit();
}

// Get the user
$user = User::LoadFromDB($db, $username, $password);
if ($user === null) {
    AddLog($db, 0, 0, 'login', "User connection failed - User \"$username\" not found");
    Done(1, 'Invalid username or password');
}

AddLog($db, $user->ID, 0, 'login', 'User connection successful');
Done(0, 'Logged in successfully', $user);

?>