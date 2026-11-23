(function () {
  var boot = document.getElementById('boot');
  var timer = setTimeout(fail, 8000);
  function fail() {
    if (!window.switchboardStarted && boot !== null) {
      clearTimeout(timer);
      boot.className = 'failed';
    }
  }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) fail();
  }, true);
  boot.querySelector('button').addEventListener('click', function () { location.reload(); });
})();
