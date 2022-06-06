/**
 * @typedef {'database'|'logs'|'notes'|'passwords'|'sandbox'|'user'} Pages
 */

PreventResubmissionAlert();

var deveye = new DevEye();
window.addEventListener('load', deveye.Mount.bind(deveye));
window.addEventListener('beforeunload', deveye.Unmount.bind(deveye));