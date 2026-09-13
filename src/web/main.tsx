import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

export function BootstrapScreen() {
  return (
    <main style={{ maxWidth: 760, margin: "10vh auto", padding: "0 24px", fontFamily: "system-ui, sans-serif", color: "#182736", lineHeight: 1.6 }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: "#42566b" }}>Application scaffold</p>
      <h1 style={{ fontSize: "clamp(32px, 6vw, 48px)", margin: "8px 0" }}>PromiseGuard</h1>
      <p>Incident follow-up across GitHub, HubSpot, Slack, and Gmail.</p>
      <p>No workflows have been run.</p>
      <p>The operator console and connected workflows are planned for the next implementation stages.</p>
      <a href="/api/health" style={{ color: "#164fa3" }}>View server health</a>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><BootstrapScreen /></StrictMode>);
