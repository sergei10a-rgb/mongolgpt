;(function () {
  var defaultTheme = "mongolgpt"
  var themeKey = "mongolgpt-theme-id"
  var schemeKey = "mongolgpt-color-scheme"
  var legacyThemeKey = "opencode-theme-id"
  var legacySchemeKey = "opencode-color-scheme"
  var legacyCssPrefix = "opencode-theme-css"
  var legacyThemes = { "oc-1": true, "oc-2": true }
  var rawTheme = localStorage.getItem(themeKey) || localStorage.getItem(legacyThemeKey)
  var themeId = legacyThemes[rawTheme] ? defaultTheme : rawTheme || defaultTheme

  localStorage.setItem(themeKey, themeId)
  localStorage.removeItem(legacyThemeKey)

  var scheme = localStorage.getItem(schemeKey) || localStorage.getItem(legacySchemeKey) || "system"
  localStorage.setItem(schemeKey, scheme)
  localStorage.removeItem(legacySchemeKey)

  if (rawTheme) {
    ;["light", "dark"].forEach(function (mode) {
      var key = "mongolgpt-theme-css-" + mode
      var legacyKey = legacyCssPrefix + "-" + rawTheme + "-" + mode
      if (themeId !== defaultTheme) {
        var css = localStorage.getItem(key) || localStorage.getItem(legacyKey)
        if (css) localStorage.setItem(key, css)
      }
      localStorage.removeItem(legacyKey)
    })
  }

  if (themeId === defaultTheme) {
    localStorage.removeItem("mongolgpt-theme-css-light")
    localStorage.removeItem("mongolgpt-theme-css-dark")
  }

  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"
  var background = isDark ? "#0a0a0a" : "#ffffff"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = background

  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", background)

  if (themeId === defaultTheme) return

  var css = localStorage.getItem("mongolgpt-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "mongolgpt-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
