<?php

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST");
header("Access-Control-Allow-Headers: Content-Type");

require_once(__DIR__.'/utils.php');
require_once(__DIR__.'/lib/PHP-SQL/sql.php');

/**
 * Generate a random token
 * @param int $length The length of the token
 * @return string The token
 */
function GenerateToken($length = 32) {
    $token = bin2hex(random_bytes($length));
    return $token;
}

// Initialize the database
$db = new DataBase(true, __DIR__.'/config.json');

// Get the input data
$input = file_get_contents('php://input');
$data = json_decode($input, true) or array();

// Data, username and password must be set
if (!isset($data['username']) || !isset($data['password'])) {
    // Try to reverse engineer the input ?
    AddLog($db, 0, 2, 'hack', 'Enpoint /auth - Invalid input data');
    Done(1, 'Invalid username or password');
}

$username = $data['username'];
$password = $data['password'];

// Get the user
$resultUser = $db->QueryPrepare('Users', 'SELECT `ID`, `Password` FROM TABLE WHERE `Username` = ?', 's', [ $username ]);
if ($resultUser === false || count($resultUser) === 0) {
    AddLog($db, 0, 0, 'login', "User connection failed - User \"$username\" not found");
    Done(1, 'Invalid username or password');
}

$rawUser = $resultUser[0];
$userID = $rawUser['ID'];
$userPassword = $rawUser['Password'];

// Check if the password is correct
if (!password_verify($password, $userPassword)) {
    AddLog($db, 0, 0, 'login', "User connection failed - User \"$username\" password incorrect");
    Done(1, 'Invalid username or password');
}

// Update the user token
$newToken = GenerateToken();
$resultToken = $db->QueryPrepare(
    'Users',
    'UPDATE TABLE SET `Token` = ?, `LastLogin` = CURRENT_TIMESTAMP() WHERE `ID` = ?',
    'si',
    [
        $newToken,
        $userID
    ]
);

if ($resultToken === false) {
    $args = [
        $newToken,
        $userID
    ];
    $err = $db->GetError();
    AddLog($db, 0, 0, 'login', "User connection failed - User \"$username\" token update failed - " . $err);
    Done(1, 'Invalid username or password');
}

$userToken = json_encode(array(
    'Token' => $newToken,
    'UserID' => $userID,
    'LastLogin' => time()
));

$data = $db->encryption->Encrypt($userToken);
AddLog($db, $userID, 0, 'login', 'User connection successful');
Done(0, 'Logged in successfully', $data);

?>
