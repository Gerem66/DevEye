const SUCCESS = "<td class='project-state'><span class='badge badge-success'>Connecté</span></td>";
const WAIT = "<td class='project-state'><span class='badge badge-warning'>Connexion...</span></td>";
const ERROR = "<td class='project-state'><span class='badge badge-danger'>Déconnecté</span></td>";

function Init_Dashboard() {
    return;

    let temperature = 0;
    PingRequest('temp', undefined, function(result) {
        if (result)
            temperature = result;
    });
    let boxes = [
        [document.getElementById("bt_1"), document.getElementById("bn_1")],
        [document.getElementById("bt_2"), document.getElementById("bn_2")],
        [document.getElementById("bt_3"), document.getElementById("bn_3")],
        [document.getElementById("bt_4"), document.getElementById("bn_4")]
    ];
    let contents = [
        ["Serveur DHCP (Temp : " + temperature + "°C)", "10.42.0.1"],
        ["NAS", "10.42.0.143"],
        ["Accès Internet", "www.google.com"],
        ["Geremy.eu", "geremy.eu"]
    ];
    if (boxes.length == contents.length) {
        // Set text
        for (let i = 0; i < boxes.length; i++) {
            boxes[i][0].innerHTML = contents[i][0];
            boxes[i][1].innerHTML = WAIT;
            PingRequest('ping', contents[i][0], function(result) {
                boxes[i][1].innerHTML = result === 'OK' ? SUCCESS : ERROR;
            });
        }
    }
}

function PingRequest(action, ip, callback) {
    const fd = new FormData();
    fd.append('action', action);
    if (typeof(ip) !== 'undefined') {
        fd.append('ip', ip);
    }
    const params = { method: 'POST', body: fd };
    fetch('./dashboard', params)
        .then(function(response) { return response.text(); })
        .then(function(content) {
            if (content != '' && typeof(callback) === 'function') {
                callback(content);
            }
        });
}