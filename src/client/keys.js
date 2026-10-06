// Keyboard shortcuts; press ? for the list. Elements opt in with aria-keyshortcuts,
// list rows with data-nav-item (and data-nav-link on the link that opens them).
(function () {
  var GO = { h: "/", c: "/changelog", n: "/notifications" };
  var prefix = null;
  var prefixTimer;

  function editable(el) {
    return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function visible(el) {
    return el.getClientRects().length > 0;
  }

  // The first visible element that declares this key in aria-keyshortcuts.
  function bound(key) {
    var els = document.querySelectorAll("[aria-keyshortcuts]");
    for (var i = 0; i < els.length; i++) {
      if (els[i].getAttribute("aria-keyshortcuts").split(" ").indexOf(key) !== -1 && visible(els[i])) return els[i];
    }
    return null;
  }

  function rows() {
    return Array.prototype.filter.call(document.querySelectorAll("[data-nav-item]"), visible);
  }

  function currentRow() {
    var active = document.activeElement;
    return active instanceof Element ? active.closest("[data-nav-item]") : null;
  }

  function moveRow(step) {
    var list = rows();
    if (!list.length) return false;
    var index = list.indexOf(currentRow());
    var next = list[index === -1 ? 0 : Math.min(list.length - 1, Math.max(0, index + step))];
    var link = next.querySelector("[data-nav-link]");
    if (!link) return false;
    link.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
    return true;
  }

  function closeMenus() {
    var open = document.querySelectorAll("details[data-menu][open]");
    open.forEach(function (menu) {
      menu.removeAttribute("open");
    });
    return open.length > 0;
  }

  function handle(key) {
    if (prefix === "g") {
      prefix = null;
      if (!GO.hasOwnProperty(key)) return false;
      location.href = GO[key];
      return true;
    }
    if (key === "g") {
      prefix = "g";
      clearTimeout(prefixTimer);
      prefixTimer = setTimeout(function () {
        prefix = null;
      }, 1500);
      return true;
    }
    if (key === "j") return moveRow(1);
    if (key === "k") return moveRow(-1);
    var row = currentRow();
    if (key === "o" && row) {
      var link = row.querySelector("[data-nav-link]");
      if (link) link.click();
      return !!link;
    }
    if (key === "v") {
      var scope = row || document.querySelector("[data-request]");
      var vote = scope && scope.querySelector("[data-vote]");
      if (vote) vote.click();
      return !!vote;
    }
    var target = bound(key);
    if (!target) return false;
    if (editable(target)) target.focus();
    else target.click();
    return true;
  }

  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      if (closeMenus()) event.preventDefault();
      else if (editable(event.target) && event.target.tagName !== "SELECT") event.target.blur();
      return;
    }
    // Typing, and the shortcut dialog itself, keep their keys.
    if (editable(event.target) || document.querySelector("dialog[open]")) return;
    if (handle(event.key)) event.preventDefault();
  });

  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    var dialog = document.getElementById("shortcuts");
    if (!target || !dialog) return;
    if (target.closest("[data-shortcuts-open]")) dialog.showModal();
    // A click on the backdrop lands on the dialog element itself.
    else if (target === dialog) dialog.close();
  });

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-shortcuts-open]").forEach(function (button) {
      button.hidden = false;
    });
  });
})();
