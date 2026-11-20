import "./rafshim";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installRemoteImages } from "./utils/markdown";

// a picture from elsewhere in rendered text loads only when a person presses "Load image" on it
installRemoteImages();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
