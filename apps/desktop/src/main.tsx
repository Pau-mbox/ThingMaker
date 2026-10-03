import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { isRemote } from "./bridge";

const container = document.getElementById("root");
if (/Windows/i.test(navigator.userAgent)) document.documentElement.dataset.platform = "windows";
if (isRemote) {
  document.documentElement.dataset.platform = "android";
  // Some Android WebViews report zero CSS viewport units on the first layout.
  // Pixel height also follows adjustResize when the software keyboard opens.
  const resize = () => document.documentElement.style.setProperty("--android-viewport-height", `${window.innerHeight}px`);
  resize(); window.addEventListener("resize", resize);
}
if (!container) {
  throw new Error("root element missing");
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
