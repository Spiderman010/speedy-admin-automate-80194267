import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

function resolveBuildCommitSha() {
  const envCommit = process.env.VITE_COMMIT_SHA || process.env.GITHUB_SHA;
  if (envCommit) return envCommit;

  try {
    return execSync("git rev-parse HEAD", {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function buildCommitMetaPlugin() {
  return {
    name: "build-commit-meta",
    transformIndexHtml(html: string) {
      const commitSha = resolveBuildCommitSha();
      const metaTag = `<meta name="build-commit" content="${commitSha}">`;
      const withoutExistingMeta = html.replace(/\s*<meta\s+name=["']build-commit["'][^>]*>\s*/gi, "\n");

      if (withoutExistingMeta.includes("</head>")) {
        return withoutExistingMeta.replace("</head>", `  ${metaTag}\n  </head>`);
      }

      return `${withoutExistingMeta}\n${metaTag}`;
    },
  };
}

// The checked-in MCP Edge Function is intentionally type-checked and owned.
// Do not re-enable mcpPlugin() until its generated Deno output preserves types.
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger(), buildCommitMetaPlugin()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
