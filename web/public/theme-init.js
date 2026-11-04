(function () {
  var mode = 'auto';
  try {
    var saved = localStorage.getItem('clive.theme');
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch (e) { }
  var dark = mode === 'dark' || (mode === 'auto' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
