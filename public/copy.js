/* Copy-to-clipboard for code blocks. External file, not inline, because the
   CSP is script-src 'self' — an inline handler would be blocked. */
document.addEventListener("click", function (e) {
  var b = e.target.closest("button.copy");
  if (!b) return;
  var pre = document.getElementById(b.getAttribute("data-copy"));
  if (!pre || !navigator.clipboard) return;
  navigator.clipboard.writeText(pre.textContent).then(function () {
    var was = b.textContent;
    b.textContent = "copied";
    setTimeout(function () { b.textContent = was; }, 1400);
  });
});
