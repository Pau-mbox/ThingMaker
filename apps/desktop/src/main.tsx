import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { IS_REMOTE } from "./remote/mode";

// Platform styles (scrollbars, fonts, the phone's drawer) key off this attribute.
if (/Windows/i.test(navigator.userAgent)) document.documentElement.dataset.platform = "windows";
if (IS_REMOTE) {
  document.documentElement.dataset.platform = "android";
  // Some Android WebViews report zero viewport units on the first layout,
  // and the pixel height follows the keyboard opening.
  const fit = () => document.documentElement.style.setProperty("--android-viewport-height", `${window.innerHeight}px`);
  fit();
  window.addEventListener("resize", fit);
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing");
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
