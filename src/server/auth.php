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

// Initialize
$output = array(
    'status' => 'error',
    'message' => 'Unknown error'
);
$db = new DataBase();

// Get the input data
$input = file_get_contents('php://input');
$data = json_decode($input, true);

$username = $data['username'];
$password = $data['password'];
if (!isset($username, $password)) {
    $output['message'] = 'Missing username or password';
    exit(json_encode($output));
}

$IP = $db->GetClientIP();
$hashedPassword = $db->encryption->HashPassword($password);

// Get the user
$result = $db->QueryPrepare('Users', 'SELECT * FROM TABLE WHERE `Username` = ?', 's', [ $username ]);
if ($result === false || count($result) === 0) {
    AddLog($db, 0, $IP, 0, 'login', "User connection failed - User \"$username\" not found");
    $output['message'] = 'Invalid username or password';
    exit(json_encode($output));
}

$rawUser = $result[0];
$user = User::Load($rawUser, $hashedPassword, $IP);
if ($user === null) {
    AddLog($db, 0, $IP, 0, 'login', "User connection failed - User \"$username\" not found");
    $output['message'] = 'Invalid username or password';
    exit(json_encode($output));
}

if (!password_verify($password, $user->Password)) {
    AddLog($db, $user->ID, $IP, 1, 'login', 'User connection failed - wrong password');
    $output['message'] = 'Invalid username or password';
    exit(json_encode($output));
}

AddLog($db, $user->ID, $IP, 0, 'login', 'User connection successful');
$output['user'] = $user;
$output['message'] = 'Logged in successfully';
$output['status'] = 'success';

echo(json_encode($output));

?>