<?php

    /**
     * @var User $user
     * @var DataBase $db
     */

    /**
     * Function called to perform server side operations\
     * once the page is loaded (often user actions)
     * @param DataBase $db
     * @param User $user
     * @param string $type
     * @param array $args
     * @return array Array returned to the client
     */
    $action = function($db, $user, $type, $args) {
        $output = array(
            'status' => 'error',
            'result' => 'empty'
        );

        switch ($type) {
            case 'php':
                $code = $args['code'];

                if ($user->Level >= 2) {
                    $result = null;
                    try {

                        $containsFunc = preg_match('/function[\\s\\t]*(\\S.+)[\\s\\t]*\\(/', $code) === 1;
                        $containsClass = preg_match('/class[\\s\\t]*(\\S.+)[\\s\\t]*\\{/', $code) === 1;
                        $containsGlobal = preg_match('/\$GLOBALS/', $code) === 1;

                        if ($containsFunc || $containsClass) {
                            $output['result'] = 'It is impossible to use functions or classes, you can use arrow functions instead';
                            break;
                        }

                        if ($containsGlobal) {
                            $output['result'] = 'It is impossible to use $GLOBALS';
                            break;
                        }

                        $syntaxCheck = trim(shell_exec("echo " . escapeshellarg($code) . " | php -l"));
                        if (!StartsWith($syntaxCheck, 'No syntax errors detected')) {
                            $output['result'] = $syntaxCheck;
                            break;
                        }

                        unset($db);
                        unset($user);

                        $result = eval($code);
                        if ($result === null) {
                            $output['result'] = 'Failed to execute the code';
                        } else {
                            $output['status'] = 'ok';
                            $output['result'] = $result;
                        }
                    } catch (ParseError $e) {
                        $output['result'] = $e->getMessage();
                    } catch (Exception $e) {
                        $output['result'] = $e->getMessage();
                    }
                } else {
                    // TODO - Add cheat suspicion
                }
                break;
        }

        return $output;
    };

    $variables = array(
        'username' => $user->Username
    );
    return ImportHTML(__DIR__.'/index.html', $variables);

?>