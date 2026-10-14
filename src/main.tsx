import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App.tsx"
import "./index.css"

if (import.meta.env.DEV) {
  void import("./devHook.ts")
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
