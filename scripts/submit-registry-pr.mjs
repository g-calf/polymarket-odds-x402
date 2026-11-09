// Generalized MCP-registry PR submitter. Pass TARGET=<key> env var:
//   TARGET=wong2 | mctrinh | mobinx
// Forks the repo, inserts our entry in the configured section,
// opens PR. Only touches README.md.
import { Buffer } from "node:buffer";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}
const TARGET_KEY = process.env.TARGET;
if (!TARGET_KEY) {
  console.error("TARGET env var required (wong2 | mctrinh | mobinx)");
  process.exit(1);
}

const USER = "ValleyofJays";

// Base entries, phrased per target convention.
const WONG2_ENTRY =
  "- **[Goldencalf — Polymarket + Kalshi odds (x402)](https://github.com/g-calf/polymarket-odds-x402)** - Pay-per-call x402 API on Base mainnet for live Polymarket and Kalshi prediction market odds. MCP server [`@gcalf/mcp`](https://www.npmjs.com/package/@gcalf/mcp) exposes `get_polymarket_odds`, `get_kalshi_odds`, and batch tools. $0.001–$0.02 USDC per call, no API keys, pre-paywall validation so bad slugs never charge.";

const MCTRINH_ENTRY =
  "* [Goldencalf — Polymarket + Kalshi odds (x402)](https://github.com/g-calf/polymarket-odds-x402) - Pay-per-call x402 API on Base mainnet for live Polymarket and Kalshi prediction market odds. MCP server `@gcalf/mcp` exposes `get_polymarket_odds`, `get_kalshi_odds`, and batch tools. $0.001–$0.02 USDC per call, no API keys.";

const MOBINX_ENTRY =
  "-   **[g-calf/polymarket-odds-x402](https://github.com/g-calf/polymarket-odds-x402)** [![GitHub stars](https://img.shields.io/github/stars/g-calf/polymarket-odds-x402?style=social)](https://github.com/g-calf/polymarket-odds-x402): Pay-per-call x402 API on Base mainnet for live Polymarket and Kalshi prediction market odds. MCP server `@gcalf/mcp` exposes `get_polymarket_odds`, `get_kalshi_odds`, and batch tools. $0.001–$0.02 USDC per call, no API keys.";

const TARGETS = {
  wong2: {
    owner: "wong2",
    repo: "awesome-mcp-servers",
    forkName: "awesome-mcp-servers-1",
    entry: WONG2_ENTRY,
    // Flat alphabetical Community Servers list. Insert among existing bullets.
    locate(content) {
      const headingIdx = content.indexOf("## Community Servers");
      if (headingIdx === -1) throw new Error("no Community Servers heading");
      const eol = content.indexOf("\n", headingIdx);
      const nextHeading = content.indexOf("\n## ", eol);
      return {
        sectionStart: eol + 1,
        sectionEnd: nextHeading === -1 ? content.length : nextHeading + 1,
      };
    },
  },
  mctrinh: {
    owner: "mctrinh",
    repo: "awesome-mcp-servers",
    forkName: "awesome-mcp-servers-2",
    entry: MCTRINH_ENTRY,
    locate(content) {
      const headingIdx = content.indexOf("## Community Servers");
      if (headingIdx === -1) throw new Error("no Community Servers heading");
      const eol = content.indexOf("\n", headingIdx);
      const nextHeading = content.indexOf("\n## ", eol);
      return {
        sectionStart: eol + 1,
        sectionEnd: nextHeading === -1 ? content.length : nextHeading + 1,
      };
    },
  },
  mobinx: {
    owner: "MobinX",
    repo: "awesome-mcp-list",
    entry: MOBINX_ENTRY,
    locate(content) {
      // Section heading contains both "Finance" and "Fintech" at H3 (### 💰 Finance & Fintech)
      const re = /\n(###[^\n]*Finance[^\n]*Fintech[^\n]*)\n/i;
      const m = content.match(re);
      if (!m) throw new Error("no Finance & Fintech H3 heading in MobinX");
      const sectionStart = m.index + m[0].length;
      // Next ### or ## heading
      const nextRe = /\n#{2,3} /g;
      nextRe.lastIndex = sectionStart;
      const next = nextRe.exec(content);
      return {
        sectionStart,
        sectionEnd: next ? next.index + 1 : content.length,
      };
    },
  },
};

const TARGET = TARGETS[TARGET_KEY];
if (!TARGET) {
  console.error(`unknown TARGET: ${TARGET_KEY}`);
  process.exit(1);
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "g-calf-submit",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return json;
}

console.log(`\n=== Submitting to ${TARGET.owner}/${TARGET.repo} ===`);

// 1. Fork with explicit name to avoid collisions with same-named forks
const FORK_NAME = TARGET.forkName ?? TARGET.repo;
console.log(`1. forking as ${USER}/${FORK_NAME}...`);
await gh("POST", `/repos/${TARGET.owner}/${TARGET.repo}/forks`, {
  name: FORK_NAME,
  default_branch_only: true,
});

// 2. Wait for fork
console.log("2. waiting for fork...");
let ready = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    await gh("GET", `/repos/${USER}/${FORK_NAME}`);
    ready = true;
    break;
  } catch {}
}
if (!ready) throw new Error("fork did not appear within 60s");
console.log("   fork ready");

// 3. Sync fork
console.log("3. syncing with upstream...");
try {
  await gh("POST", `/repos/${USER}/${FORK_NAME}/merge-upstream`, {
    branch: "main",
  });
} catch (e) {
  console.log("   sync note:", String(e).slice(0, 200));
}

// 4. Fetch README via Git data API (safe for any file size)
console.log("4. fetching README...");
const branch = await gh(
  "GET",
  `/repos/${USER}/${FORK_NAME}/branches/main`,
);
const latestCommit = branch.commit.sha;
const tree = await gh(
  "GET",
  `/repos/${USER}/${FORK_NAME}/git/trees/${latestCommit}`,
);
const readmeEntry = tree.tree.find((t) => t.path === "README.md");
if (!readmeEntry) throw new Error("README.md not found in tree root");
const blob = await gh(
  "GET",
  `/repos/${USER}/${FORK_NAME}/git/blobs/${readmeEntry.sha}`,
);
const original = Buffer.from(blob.content, "base64").toString("utf8");
console.log(`   README ${original.length} bytes`);

// 5. Check idempotency + insert
if (original.includes("g-calf/polymarket-odds-x402")) {
  console.log("entry already present; aborting");
  process.exit(0);
}

const { sectionStart, sectionEnd } = TARGET.locate(original);
const section = original.slice(sectionStart, sectionEnd);
console.log(`5. section is ${section.length} bytes, ${section.split("\n").length} lines`);

const lines = section.split("\n");
// Bullet markers vary by repo: "- [", "- **[", "* [", "-   **["
const bulletRe = /^[-*] /;
const bullets = [];
for (let i = 0; i < lines.length; i++) {
  if (bulletRe.test(lines[i])) bullets.push({ i, text: lines[i] });
}
if (bullets.length === 0) throw new Error("no bullets found in section");

function sortKey(line) {
  // Extract first bracketed [name] from the line, lowercase.
  const m = line.match(/\[([^\]]+)\]/);
  return (m ? m[1] : line).toLowerCase();
}
const myKey = sortKey(TARGET.entry);
let insertBeforeLine = bullets[bullets.length - 1].i + 1;
for (const b of bullets) {
  if (sortKey(b.text) > myKey) {
    insertBeforeLine = b.i;
    break;
  }
}
lines.splice(insertBeforeLine, 0, TARGET.entry);
const newSection = lines.join("\n");
const newContent = original.slice(0, sectionStart) + newSection + original.slice(sectionEnd);

if (newContent === original) {
  console.log("no changes; aborting");
  process.exit(0);
}

// 6. Commit via Git data API
console.log("6. committing...");
const newBlob = await gh("POST", `/repos/${USER}/${FORK_NAME}/git/blobs`, {
  content: Buffer.from(newContent, "utf8").toString("base64"),
  encoding: "base64",
});
const newTree = await gh("POST", `/repos/${USER}/${FORK_NAME}/git/trees`, {
  base_tree: latestCommit,
  tree: [
    { path: "README.md", mode: "100644", type: "blob", sha: newBlob.sha },
  ],
});
const newCommit = await gh(
  "POST",
  `/repos/${USER}/${FORK_NAME}/git/commits`,
  {
    message: "Add g-calf/polymarket-odds-x402 (prediction market odds via x402)",
    tree: newTree.sha,
    parents: [latestCommit],
    author: { name: "g-calf", email: "parab01ek@gmail.com" },
    committer: { name: "g-calf", email: "parab01ek@gmail.com" },
  },
);
await gh("PATCH", `/repos/${USER}/${FORK_NAME}/git/refs/heads/main`, {
  sha: newCommit.sha,
});

// 7. Open PR
console.log("7. opening PR...");
const pr = await gh("POST", `/repos/${TARGET.owner}/${TARGET.repo}/pulls`, {
  title: "Add g-calf/polymarket-odds-x402 (prediction market odds, x402)",
  head: `${USER}:main`,
  head_repo: FORK_NAME,
  base: "main",
  body: `Adds [\`@gcalf/mcp\`](https://www.npmjs.com/package/@gcalf/mcp) + its backing API.

- npm: https://www.npmjs.com/package/@gcalf/mcp
- API: https://polymarket-odds-x402.goldencalf.workers.dev
- Source: https://github.com/g-calf/polymarket-odds-x402

Niche: single-source Polymarket + Kalshi specialization (rather than a general-purpose x402 gateway). All endpoints have JSON Schema discovery at \`/.well-known/x402\` and \`/openapi.json\`; a pre-paywall validator means bad slugs return 404 without taking payment.`,
  maintainer_can_modify: true,
});

console.log(`\nPR opened: ${pr.html_url}`);
