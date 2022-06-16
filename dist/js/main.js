/**
 * @typedef {'database'|'logs'|'mails'|'notes'|'passwords'|'sandbox'|'user'} Pages
 */

var deveye = new DevEye();
window.addEventListener('load', deveye.Mount.bind(deveye));
window.addEventListener('beforeunload', deveye.Unmount.bind(deveye));