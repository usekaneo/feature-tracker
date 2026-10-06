// Loaded blocking in <head> so the stored theme applies before first paint.
(function () {
  var KEY = "theme";
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (e) {
      return null;
    }
  }

  function apply() {
    root.dataset.theme = stored() || (media.matches ? "dark" : "light");
  }

  apply();
  media.addEventListener("change", apply);

  // Close open menus on a tap or click outside them.
  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    document.querySelectorAll("details[data-menu][open]").forEach(function (menu) {
      if (!target || !menu.contains(target)) menu.removeAttribute("open");
    });
  });

  document.addEventListener("click", function (event) {
    var button = event.target instanceof Element && event.target.closest("[data-theme-toggle]");
    if (!button) return;
    var next = root.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch (e) {}
    apply();
  });
})();
