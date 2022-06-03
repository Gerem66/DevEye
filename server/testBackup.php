<?php

    // Sources:
    // https://wyrmo.com/OxyDev/features/server.php
    // https://webdevdesigner.com/q/how-to-create-websockets-server-in-php-75388/
    // https://medium.com/@cn007b/super-simple-php-websocket-example-ea2cd5893575
    // https://stackoverflow.com/questions/58723593/socket-read-unable-to-read-from-socket-104-connection-reset-by-peer-php
    // https://stackoverflow.com/questions/14512182/how-to-create-websockets-server-in-php
    // https://www.cuelogic.com/blog/php-and-html5-websocket-server-and-client-communication

    /*error_reporting(E_ALL);
    set_time_limit(0);
    ob_implicit_flush();

    $master  = WebSocket("0.0.0.0", 8080);
    $sockets = array($master);
    $users   = array();
    $debug   = true;

    while (true) {
        $changed = $sockets;
        $write=NULL;
        $except=NULL;
        socket_select($changed, $write, $except, NULL);
        foreach($changed as $socket) {
            if($socket==$master) {
                $client=socket_accept($master);
                if ($client === false) {
                    console("socket_accept() failed");
                    continue;
                }
                else {
                    connect($client);
                }
            } else {
                $bytes = @socket_recv($socket,$buffer,2048,0);
                if ($bytes == 0) {
                    disconnect($socket);
                } else {
                    $user = getuserbysocket($socket);
                    if(!$user->handshake) {
                        dohandshake($user,$buffer);
                    } else {
                        echo(socket_last_error());
                        print_r($socket);
                        //process($user,$buffer);
                    }
                }
            }
        }
    }

    //---------------------------------------------------------------
    function process($user,$msg) {
        $action = unwrap($msg);
        say("< ".$action);
        switch($action) {
            case "hello" : send($user->socket,"hello human");                       break;
            case "hi"    : send($user->socket,"zup human");                         break;
            case "name"  : send($user->socket,"my name is Multivac, silly I know"); break;
            case "age"   : send($user->socket,"I am older than time itself");       break;
            case "date"  : send($user->socket,"today is ".date("Y.m.d"));           break;
            case "time"  : send($user->socket,"server time is ".date("H:i:s"));     break;
            case "thanks": send($user->socket,"you're welcome");                    break;
            case "bye"   : send($user->socket,"bye");                               break;
            default      : send($user->socket,$action." not understood");           break;
        }
    }

    function send($client,$msg){
        say("> ".$msg);
        $msg = wrap($msg);
        socket_write($client,$msg,strlen($msg));
    }

    function WebSocket($address,$port){
        $master = socket_create(AF_INET, SOCK_DGRAM, SOL_TCP) or die("socket_create() failed");
        socket_set_option($master, SOL_SOCKET, SO_REUSEADDR, 1)  or die("socket_option() failed");
        socket_bind($master, $address, $port)                    or die("socket_bind() failed");
        socket_listen($master,20)                                or die("socket_listen() failed");
        echo "Server Started : ".date('Y-m-d H:i:s')."\n";
        echo "Master socket  : ".$master."\n";
        echo "Listening on   : ".$address." port ".$port."\n\n";
        return $master;
    }

    function connect($socket){
        global $sockets,$users;
        $user = new User();
        $user->id = uniqid();
        $user->socket = $socket;
        array_push($users,$user);
        array_push($sockets,$socket);
        console($socket." CONNECTED!");
    }

    function disconnect($socket){
        global $sockets, $users;
        $found = null;
        $n = count($users);
        for ($i = 0; $i < $n; $i++) {
            if ($users[$i]->socket == $socket) {
                $found = $i;
                break;
            }
        }
        if (!is_null($found)) {
            array_splice($users,$found,1);
        }
        $index = array_search($socket, $sockets);
        socket_close($socket);
        console($socket." DISCONNECTED!");
        if ($index >= 0) {
            array_splice($sockets,$index,1);
        }
    }

    function dohandshake($user,$buffer){
        console("\nRequesting handshake...");
        console($buffer);
        //list($resource,$host,$origin,$strkey1,$strkey2,$data) 
        list($resource,$host,$u,$c,$key,$protocol,$version,$origin,$data) = getheaders($buffer);
        console("Handshaking...");

        $acceptkey = base64_encode(sha1($key . "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",true));
        $upgrade  = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $acceptkey\r\n";

        socket_write($user->socket,$upgrade,strlen($upgrade));
        $user->handshake=true;
        console($upgrade);
        console("Done handshaking...");
        return true;
    }

    function getheaders($req) {
        print_r('START HEADERS');
        print_r($req);
        print_r('END HEADERS');

        $r=$h=$u=$c=$key=$protocol=$version=$o=$data=null;
        if (preg_match("/GET (.*) HTTP/"   ,$req,$match)) { $r=$match[1]; }
        if (preg_match("/Host: (.*)\r\n/"  ,$req,$match)) { $h=$match[1]; }
        if (preg_match("/Upgrade: (.*)\r\n/",$req,$match)) { $u=$match[1]; }
        if (preg_match("/Connection: (.*)\r\n/",$req,$match)) { $c=$match[1]; }
        if (preg_match("/Sec-WebSocket-Key: (.*)\r\n/",$req,$match)) { $key=$match[1]; }
        if (preg_match("/Sec-WebSocket-Protocol: (.*)\r\n/",$req,$match)) { $protocol=$match[1]; }
        if (preg_match("/Sec-WebSocket-Version: (.*)\r\n/",$req,$match)) { $version=$match[1]; }
        if (preg_match("/Origin: (.*)\r\n/",$req,$match)) { $o=$match[1]; }
        if (preg_match("/\r\n(.*?)\$/",$req,$match)) { $data=$match[1]; }
        return array($r,$h,$u,$c,$key,$protocol,$version,$o,$data);
    }

    function getuserbysocket($socket) {
        global $users;
        $found=null;
        foreach ($users as $user) {
            if($user->socket == $socket) {
                $found = $user;
                break;
            }
        }
        return $found;
    }

    function     say($msg="") { echo $msg."\n"; }
    function    wrap($msg="") { return chr(0).$msg.chr(255); }
    function  unwrap($msg="") { return substr($msg,1,strlen($msg)-2); }
    function console($msg="") { global $debug; if ($debug) { echo $msg."\n"; } }

    class User {
        var $id;
        var $socket;
        var $handshake;
    }*/

    /*$address = '0.0.0.0';
    $port = 8080;
    echo("Start...");

    // Create WebSocket.
    $server = socket_create(AF_INET, SOCK_STREAM, SOL_TCP);
    socket_set_option($server, SOL_SOCKET, SO_REUSEADDR, 1);
    socket_bind($server, $address, $port);
    socket_listen($server);
    $client = socket_accept($server);

    // Send WebSocket handshake headers.
    $request = socket_read($client, 5000);
    preg_match('#Sec-WebSocket-Key: (.*)\r\n#', $request, $matches);
    $key = base64_encode(pack(
        'H*',
        sha1($matches[1] . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    ));
    $headers = "HTTP/1.1 101 Switching Protocols\r\n";
    $headers .= "Upgrade: websocket\r\n";
    $headers .= "Connection: Upgrade\r\n";
    $headers .= "Sec-WebSocket-Version: 13\r\n";
    $headers .= "Sec-WebSocket-Accept: $key\r\n\r\n";
    socket_write($client, $headers, strlen($headers));

    // Send messages into WebSocket in a loop.
    $i = 5;
    while ($i-- > 0) {
        echo($i);
        sleep(1);
        $content = 'Now: ' . time();
        $response = chr(129) . chr(strlen($content)) . $content;
        socket_write($client, $content);
    }*/


    //header("Content-Type: text/plain; charset=utf-8");
    set_time_limit(0); // disable timeout
    ob_implicit_flush(); // disable output caching 

    function shutdown() {
        global $socket;
        socket_shutdown($socket);
        socket_close($socket);
        echo("Closed\n");
        exit();
    };
    register_shutdown_function("shutdown");
    declare(ticks = 1); // Allow posix signal handling
    pcntl_signal(SIGINT, "shutdown");
    //pcntl_signal(SIGTERM, "shutdown");

    // Settings    
    $address = '0';
    $port = 8080;

    if (($socket = socket_create(AF_INET, SOCK_STREAM, SOL_TCP)) === false) {
        echo "Couldn't create socket".socket_strerror(socket_last_error())."\n";
    }

    socket_setopt($socket, SOL_SOCKET, SO_REUSEADDR, 1);

    if (socket_bind($socket, $address, $port) === false) {
        echo "Bind Error ".socket_strerror(socket_last_error($sock)) ."\n";
    }

    if (socket_listen($socket, 5) === false) {
        echo "Listen Failed ".socket_strerror(socket_last_error($socket)) . "\n";
    }

    while (true) {
        if (($msgsock = socket_accept($socket)) === false) {
            echo "Error: socket_accept: " . socket_strerror(socket_last_error($socket)) . "\n";
            break;
        }

        // Listen to user input
        while (true) {
            $buf = socket_read($msgsock, 2048);
            if ($buf === false) {
                echo "socket read error: ".socket_strerror(socket_last_error($msgsock)) . "\n";
                break;
            }
            if (!$buf = trim($buf)) {
                continue;
            }

            // Reply to user with their message
            $talkback = "PHP: You said '$buf'.\n";
            socket_write($msgsock, $talkback, strlen($talkback));

            // Print message in terminal
            print_r($buf);
            ///echo(mb_convert_encoding($buf, 'UTF-8')."\n");
        }
        socket_close($msgsock);
    }

    socket_close($socket);

?>