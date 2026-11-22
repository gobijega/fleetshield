// Applies the saved light/dark choice before the page is drawn, so it
// never flashes the wrong theme. With no saved choice, the device's own
// setting decides. Loaded in <head> on every page (external file: the CSP
// does not allow inline scripts).
(function () {
  var t = null;
  try {
    t = localStorage.getItem('fs.theme');
  } catch {
    /* storage blocked: fall back to the device setting */
  }
  if (t !== 'light' && t !== 'dark') {
    t =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
