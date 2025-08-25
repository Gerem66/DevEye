<?php

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST");
header("Access-Control-Allow-Headers: Content-Type");

require_once(__DIR__.'/utils.php');
require_once(__DIR__.'/functions.php');
require_once(__DIR__.'/PHP-SQL/sql.php');

// Initialize the database
$db = new DataBase();

// Get the input data
$input = file_get_contents('php://input');
$data = json_decode($input, true);

$code = $data['code'];
$token = $data['token'];
if (!isset($code, $token) || $code !== 'UJu-79a?:w=4O7mp#sM]yQiOsI/Jb_ag') {
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

// Return the token data
Done(0, 'Token is valid', $tokenData['Token']);

?>
