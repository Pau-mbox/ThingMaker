/** Development-only design fixture. Never part of the packaged application entry. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ActivitySnapshot, WorkspaceRecord } from "@thingmaker/contracts";
import ChillView from "./ChillView";
import "../styles.css";
const now = Date.now();
const workspaces: WorkspaceRecord[] = [
  "Undercover",
  "PocketGod",
  "Little Atlas",
  "ThingMaker",
].map((name, i) => ({
  id: `p${i}`,
  environmentId: "local",
  canonicalRoot: `/projects/${name}`,
  displayPath: `/projects/${name}`,
  workspaceHash: `p${i}`,
  trustState: "trusted_local",
  createdAt: now,
}));
const snapshot: ActivitySnapshot = {
  revision: "1",
  observedAt: now,
  jobs: [],
  goals: [
    {
      id: "g1",
      workspaceId: "p0",
      title: "A little polish",
      state: "running",
      verified: 3,
      total: 7,
      pending: 0,
      sessionId: "b0",
    },
  ],
  actors: [],
  files: [],
};
for (let p = 0; p < workspaces.length; p++) {
  for (let i = 0; i < 9 + p * 2; i++) {
    const path = [
      "src/scene.ts",
      "assets/meadow.png",
      "src/App.tsx",
      "src/characters.ts",
      "README.md",
      "src/music.ts",
      "src/flowers.ts",
      "src/layout.ts",
      "tests/garden.test.ts",
    ][i % 9]!;
    snapshot.files.push({
      id: `p${p}:${path}${i > 8 ? i : ""}`,
      workspaceId: `p${p}`,
      path: `${path}${i > 8 ? i : ""}`,
      external: false,
      operation: i % 3 ? "edit" : "read",
      touchedAt: now - i * 20 * 60_000,
      sessionId: `b${p}`,
      activeActors: i === 0 ? [`b${p}`] : [],
    });
  }
  for (let i = 0; i < (p === 0 ? 4 : p === 1 ? 2 : 1); i++) {
    const id = i === 0 ? `b${p}` : `b${p}-${i}`;
    snapshot.actors.push({
      id,
      sessionId: id,
      workspaceId: `p${p}`,
      parentId: i ? `b${p}` : null,
      name:
        i === 0
          ? "Garden keeper"
          : ["", "Little builder", "Review bee", "Image moth"][i]!,
      provider: p % 2 ? "codex" : "claude",
      model: p % 2 ? "gpt-6-sol" : "opus",
      status: p === 3 ? "idle" : i === 3 ? "waiting" : "working",
      task:
        i === 0
          ? "Tending the next scene"
          : i === 2
            ? "Review the changes"
            : "Polish the scene and its animation",
      operation: ["edit", "build", "read", "thinking"][i]!,
      fileId: i === 0 ? `p${p}:src/scene.ts` : null,
      lastSeen: now,
      native: i === 2,
      generation: "1",
    });
  }
}
const root = document.getElementById("root");
function Preview() {
  const [capture, setCapture] = useState("");
  return (
    <>
      <ChillView
        onExit={() => window.location.assign("/")}
        preview={{ snapshot, workspaces }}
      />
      <div style={{ position: "absolute", top: 820, left: 20, padding: 20 }}>
        <button
          onClick={() =>
            setCapture(
              document.querySelector("canvas")?.toDataURL("image/png") ?? "",
            )
          }
        >
          Prepare artwork export
        </button>
        {capture && (
          <a href={capture} download="chill-garden.png">
            Download garden artwork
          </a>
        )}
        {capture && (
          <img
            src={capture}
            alt="Exported terrarium artwork"
            style={{ display: "block", width: 1280 }}
          />
        )}
      </div>
    </>
  );
}
if (import.meta.env.DEV && root) {
  const renderer = createRoot(root);
  renderer.render(<Preview />);
  import.meta.hot?.dispose(() => renderer.unmount());
}
