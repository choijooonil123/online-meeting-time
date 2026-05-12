(() => {
  const params = new URLSearchParams(window.location.search);
  const queryApiBaseUrl = params.get("apiBaseUrl");
  const storedApiBaseUrl = window.localStorage.getItem("omtApiBaseUrl");
  const hostname = window.location.hostname;

  let apiBaseUrl = "";

  if (queryApiBaseUrl) {
    apiBaseUrl = queryApiBaseUrl.trim();
    window.localStorage.setItem("omtApiBaseUrl", apiBaseUrl);
  } else if (storedApiBaseUrl) {
    apiBaseUrl = storedApiBaseUrl.trim();
  } else if (hostname === "online-meeting-time.web.app" || hostname === "online-meeting-time.firebaseapp.com") {
    apiBaseUrl = "https://online-meeting-time.onrender.com";
  }

  window.__APP_CONFIG__ = {
    apiBaseUrl,
  };
})();
