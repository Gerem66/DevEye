<?php

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST");
header("Access-Control-Allow-Headers: Content-Type");

require_once(__DIR__.'/utils.php');
require_once(__DIR__.'/functions.php');
require_once(__DIR__.'/PHP-SQL/sql.php');

// Initialize the database
$db = new DataBase(true, __DIR__.'/config.json');

// Get the input data
$input = file_get_contents('php://input');
$data = json_decode($input, true);

$token = $data['token'];
if (!isset($token)) {
    // Try to reverse engineer the input ?
    AddLog($db, 0, 2, 'hack', 'Enpoint /auto-login - Invalid input data');
    Done(1, 'Invalid token');
}

// Decrypt the token
$tokenData = $db->encryption->Decrypt($token);
if (!$tokenData) {
    AddLog($db, 0, 2, 'hack', 'Enpoint /auto-login - Invalid token');
    Done(1, 'Invalid token');
}

// Check if the token is valid
$tokenData = json_decode($tokenData, true);
if (!isset($tokenData['Token'], $tokenData['UserID'], $tokenData['LastLogin'])) {
    AddLog($db, 0, 2, 'hack', 'Enpoint /auto-login - Invalid token data');
    Done(2, 'Invalid token');
}

// Get the token data
$userID = $tokenData['UserID'];
$token = $tokenData['Token'];
$lastLogin = $tokenData['LastLogin'];

// Check if the user exists
$user = $db->QueryPrepare('Users', 'SELECT * FROM `Users` WHERE `ID` = ?', 'i', array($userID));
if ($user === false) {
    AddLog($db, 0, 0, 'login', "User connection failed - User \"$tokenData\" not found");
    Done(3, 'Invalid token');
}

// Check if the user exists
$user = $user[0];
if ($user['Token'] !== $token) {
    AddLog($db, 0, 0, 'login', "User connection failed - User \"$tokenData\" token mismatch");
    Done(4, 'Invalid token');
}

// Check if the user exists (disconnect if connected on another device ?)
//if ($user['LastLogin'] !== $lastLogin) {
//    AddLog($db, 0, 0, 'login', "User connection failed - User \"$tokenData\" last login mismatch");
//    Done(1, 'Invalid token');
//}

Done(0, 'Logged in successfully', null);

?>
