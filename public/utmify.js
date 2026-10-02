/* Utmify: pixel + captura de UTMs (mesmos scripts fornecidos pela Utmify, sem ofuscação). */
(function () {
  window.pixelId = "6abf4784eb62b1eff610b0b3";
  var head = document.head || document.documentElement;
  var pixel = document.createElement("script");
  pixel.src = "https://cdn.utmify.com.br/scripts/pixel/pixel.js";
  pixel.async = true; pixel.defer = true;
  head.appendChild(pixel);
  var utms = document.createElement("script");
  utms.src = "https://cdn.utmify.com.br/scripts/utms/latest.js";
  utms.async = true; utms.defer = true;
  utms.setAttribute("data-utmify-prevent-xcod-sck", "");
  utms.setAttribute("data-utmify-prevent-subids", "");
  head.appendChild(utms);
})();
